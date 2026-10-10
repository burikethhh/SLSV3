// SLS v3 owner-apply Edge Function.
// Self-serve onboarding: Prospective gym owners register and apply.
// Automatically provisions their gym branch with 'pending' status,
// binds the owner role, and generates an instant 14-day Free Trial license key
// so the owner can activate their terminal right away while awaiting CEO verification.
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";
import { importPrivateKey, PSS, b64url } from "../_shared/licenseCrypto.ts";

const TIERS: Record<string, { max: number; usd: number }> = {
  basic: { max: 200, usd: 99 },
  pro: { max: 500, usd: 199 },
  ultra: { max: 1000, usd: 349 },
};

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",").pop()!.trim();

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user || !user.email) {
    return new Response("unauthorized", { status: 401 });
  }

  const rl = check(`owner-apply:${ip}`, 10, 3600);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const body = await req.json();
  const gymName = String(body.gym_name ?? "").trim();
  const location = String(body.location ?? "").trim();
  const requestedTier = String(body.tier ?? "basic").toLowerCase();

  if (!gymName) return new Response("Gym name is required", { status: 400 });
  const tier = TIERS[requestedTier] ? requestedTier : "basic";

  // Check if owner already has a gym assigned to prevent duplicate spam
  const existingGymIds = (user.app_metadata?.gym_ids as string[]) ?? [];
  if (existingGymIds.length > 0) {
    const { data: existingGym } = await supa.from("gyms").select("id, name, status").in("id", existingGymIds).limit(1).maybeSingle();
    if (existingGym) {
      return Response.json({
        ok: true,
        already_applied: true,
        gym_id: existingGym.id,
        gym_name: existingGym.name,
        status: existingGym.status,
      });
    }
  }

  // 1. Create the gym in pending state
  const { data: gym, error: gymErr } = await supa
    .from("gyms")
    .insert({
      name: gymName,
      tier,
      location,
      status: "pending",
      owner_email: user.email,
    })
    .select("id, name, tier, status")
    .single();

  if (gymErr || !gym) {
    console.error("gym create failed", gymErr?.message);
    return new Response("Failed to create gym application", { status: 500 });
  }

  // 2. Provision a 14-day Free Trial License Key
  const now = new Date();
  const trialDays = 14;
  const exp = new Date(now.getTime() + trialDays * 86400_000);
  const licenseId = crypto.randomUUID();

  const claims = {
    license_id: licenseId,
    gym_id: gym.id,
    gym_name: gym.name,
    owner_email: user.email,
    tier,
    issued_at: now.toISOString(),
    expires_at: exp.toISOString(),
    max_members: TIERS[tier].max,
    hardware_lock_enabled: true,
    hwid: "",
    ip_hint: "",
    exp_unix: Math.floor(exp.getTime() / 1000),
    grace_until: Math.floor(exp.getTime() / 1000) + 3 * 86400,
  };

  const pem = Deno.env.get("RSA_PRIVATE_KEY_PEM");
  let token = "";
  if (pem && (pem.includes("BEGIN PRIVATE KEY") || pem.includes("BEGIN RSA PRIVATE KEY"))) {
    try {
      const key = await importPrivateKey(pem);
      const msg = new TextEncoder().encode(JSON.stringify(claims));
      const sig = new Uint8Array(await crypto.subtle.sign(PSS, key, msg.buffer as ArrayBuffer));
      token = `GPOS-${b64url.encode(msg)}.${b64url.encode(sig)}`;
    } catch (e) {
      console.error("trial token sign failed", e);
    }
  }

  if (!token) {
    await supa.from("gyms").delete().eq("id", gym.id);
    return new Response("Trial license provisioning failed", { status: 500 });
  }

  const { error: licenseErr } = await supa.from("licenses").insert({
      id: licenseId,
      gym_id: gym.id,
      raw_token: token,
      revoked: false,
      expires_at: claims.expires_at,
      tier,
      owner_email: user.email,
      issued_by: "system:trial",
      price_usd: 0,
      days_valid: trialDays,
      is_trial: true,
    });
  if (licenseErr) {
    await supa.from("gyms").delete().eq("id", gym.id);
    console.error("trial license insert failed", licenseErr.message);
    return new Response("Trial license provisioning failed", { status: 500 });
  }

  // 3. Upgrade user's app_metadata to 'owner' with their new gym_id
  const { error: authErr } = await supa.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...user.app_metadata,
      role: "owner",
      gym_ids: [gym.id],
      status: "pending_approval",
      gym_name: gym.name,
    },
  });
  if (authErr) {
    await supa.from("licenses").delete().eq("id", licenseId);
    await supa.from("gyms").delete().eq("id", gym.id);
    console.error("owner metadata update failed", authErr.message);
    return new Response("Application provisioning failed", { status: 500 });
  }

  // 4. Audit trail
  await supa.from("audit_logs").insert({
    gym_id: gym.id,
    actor: user.email,
    action: "owner.apply",
    reason: `Application submitted for ${gym.name} (${tier} tier) with 14-day trial`,
    meta: { gym_name: gym.name, tier, location, trial_token_issued: !!token },
  });

  return Response.json({
    ok: true,
    gym_id: gym.id,
    gym_name: gym.name,
    tier,
    status: "pending",
    token,
    expires_at: claims.expires_at,
    days_valid: trialDays,
  });
});
