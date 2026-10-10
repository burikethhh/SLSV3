// Gym admin — CEO-only. Create a gym (needed before license-issue FK),
// approve owner applications, or toggle the kill-switch (gyms.disabled).
// Both write audit rows via service_role.
// POST { action: "create"|"set_disabled"|"approve_application", gym_id?, name?, tier?, disabled?, reason? }
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";
import { importPrivateKey, PSS, b64url } from "../_shared/licenseCrypto.ts";

const TIERS: Record<string, { max: number; usd: number }> = {
  basic: { max: 200, usd: 99 },
  pro: { max: 500, usd: 199 },
  ultra: { max: 1000, usd: 349 },
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",").pop()!.trim();

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user || (user.app_metadata as { role?: string }).role !== "ceo") {
    return new Response("ceo only", { status: 403 });
  }
  const rl = check(`gym-admin:${ip}`, 60, 3600);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const body = await req.json();
  const action = String(body.action ?? "");

  if (action === "create") {
    const name = String(body.name ?? "").trim();
    const tier = String(body.tier ?? "basic");
    if (!name || !TIERS[tier]) return new Response("name + valid tier required", { status: 400 });
    const { data: gym, error } = await supa
      .from("gyms")
      .insert({ name, tier, status: "active" })
      .select("id, name, tier, disabled, status")
      .single();
    if (error) {
      console.error("gym create", error.message);
      return new Response("gym create failed", { status: 500 });
    }
    const { error: auditErr } = await supa.from("audit_logs").insert({
      gym_id: gym.id,
      actor: user.email ?? "ceo",
      action: "gym.create",
      meta: { name, tier },
    });
    if (auditErr) console.error("audit", auditErr.message);
    return Response.json({ ok: true, gym });
  }

  if (action === "approve_application") {
    const gym_id = body.gym_id;
    if (!gym_id || !UUID_RE.test(String(gym_id))) return new Response("valid gym_id required", { status: 400 });

    const { data: gym, error: findErr } = await supa
      .from("gyms")
      .select("id, name, tier, status, owner_email")
      .eq("id", gym_id)
      .maybeSingle();

    if (findErr || !gym) return new Response("gym not found", { status: 404 });
    if (gym.status !== "pending") return new Response("application is not pending", { status: 409 });

    const now = new Date();
    const days = 30; // 30 days subscription countdown starts from verification
    const exp = new Date(now.getTime() + days * 86400_000);
    const tier = TIERS[gym.tier] ? gym.tier : "basic";
    const price = TIERS[tier].usd;

    // 1. Mark gym status as active and approved_at = now
    const { data: approvedGym, error: upErr } = await supa
      .from("gyms")
      .update({ status: "active", approved_at: now.toISOString() })
      .eq("id", gym_id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (upErr) return new Response("failed to update gym status", { status: 500 });
    if (!approvedGym) return new Response("application was already processed", { status: 409 });

    // 2. Generate official 30-day production license
    const licenseId = crypto.randomUUID();
    const claims = {
      license_id: licenseId,
      gym_id: gym.id,
      gym_name: gym.name,
      owner_email: gym.owner_email,
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
        console.error("sign failed", e);
      }
    }

    if (!token) {
      await supa.from("gyms").update({ status: "pending", approved_at: null }).eq("id", gym_id);
      return new Response("Production license signing failed", { status: 500 });
    }

    const { error: licenseErr } = await supa.from("licenses").insert({
        id: licenseId,
        gym_id: gym.id,
        raw_token: token,
        revoked: false,
        expires_at: claims.expires_at,
        tier,
        owner_email: gym.owner_email,
        issued_by: user.email ?? "ceo",
        price_usd: price,
        days_valid: days,
        is_trial: false,
      });
    if (licenseErr) {
      console.error("production license insert failed", licenseErr.message);
      await supa.from("gyms").update({ status: "pending", approved_at: null }).eq("id", gym_id);
      return new Response("Production license provisioning failed", { status: 500 });
    }

    // 3. Update owner's auth user status to 'verified'
    if (gym.owner_email) {
      const { data: usersData } = await supa.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const targetUser = (usersData?.users ?? []).find((u) => u.email?.toLowerCase() === gym.owner_email.toLowerCase());
      if (targetUser) {
        const { error: authErr } = await supa.auth.admin.updateUserById(targetUser.id, {
          app_metadata: {
            ...targetUser.app_metadata,
            role: "owner",
            gym_ids: [gym.id],
            status: "verified",
            subscription_expires_at: exp.toISOString(),
          },
        });
        if (authErr) {
          await supa.from("licenses").delete().eq("id", licenseId);
          await supa.from("gyms").update({ status: "pending", approved_at: null }).eq("id", gym_id);
          console.error("owner verification update failed", authErr.message);
          return new Response("Owner verification failed", { status: 500 });
        }
      } else {
        await supa.from("licenses").delete().eq("id", licenseId);
        await supa.from("gyms").update({ status: "pending", approved_at: null }).eq("id", gym_id);
        return new Response("Owner account not found", { status: 500 });
      }
    }

    // 4. Audit row
    await supa.from("audit_logs").insert({
      gym_id: gym.id,
      actor: user.email ?? "ceo",
      action: "gym.approve_application",
      reason: `Approved owner application for ${gym.name} (${tier}). 30-day production license issued.`,
      meta: { gym_name: gym.name, tier, price_usd: price, days_valid: days },
    });

    return Response.json({
      ok: true,
      gym_id: gym.id,
      status: "active",
      token,
      expires_at: exp.toISOString(),
      days_valid: days,
    });
  }

  if (action === "set_disabled") {
    const gym_id = body.gym_id;
    if (!gym_id || !UUID_RE.test(String(gym_id))) return new Response("gym_id required", { status: 400 });
    if (typeof body.disabled !== "boolean") return new Response("disabled must be boolean", { status: 400 });
    const disabled = body.disabled;
    const reason = String(body.reason ?? "").slice(0, 500);

    const { data: gym, error: findErr } = await supa.from("gyms").select("id").eq("id", gym_id).maybeSingle();
    if (findErr || !gym) return new Response("gym not found", { status: 404 });

    const { error } = await supa.from("gyms").update({ disabled }).eq("id", gym_id);
    if (error) {
      console.error("gym update", error.message);
      return new Response("gym update failed", { status: 500 });
    }
    const { error: auditErr } = await supa.from("audit_logs").insert({
      gym_id,
      actor: user.email ?? "ceo",
      action: disabled ? "gym.kill" : "gym.enable",
      reason,
    });
    if (auditErr) console.error("audit", auditErr.message);
    return Response.json({ ok: true, gym_id, disabled });
  }

  return new Response("unknown action", { status: 400 });
});
