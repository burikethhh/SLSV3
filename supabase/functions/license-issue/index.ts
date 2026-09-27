// SLS v3 license-issue Edge Function. CEO-only. Signs GPOS-<claims>.<sig>
// (RSA-2048 PSS/SHA-256, salt 32 — see _shared/licenseCrypto.ts contract).
// Creates the gym if missing (distribution path: CEO registers gym → issue key).
// Secrets: RSA_PRIVATE_KEY_PEM, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
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
  if (!user || (user.app_metadata as { role?: string }).role !== "ceo") {
    return new Response("ceo only", { status: 403 });
  }
  const rl = check(`license-issue:${ip}`, 30, 3600);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const {
    gym_id,
    gym_name,
    tier,
    days_valid = 30,
    owner_email = "",
    hwid = "",
    create_gym = false,
  } = await req.json();
  if (!gym_name || !TIERS[tier]) return new Response("gym_name + valid tier required", { status: 400 });

  const days = Math.min(3650, Math.max(1, Number(days_valid) || 30));

  // Resolve gym: existing id, or create when create_gym / no id.
  let resolvedGymId: string | null = gym_id ?? null;
  let resolvedName = String(gym_name).trim();
  if (gym_id) {
    const { data: existing } = await supa.from("gyms").select("id, tier, name").eq("id", gym_id).maybeSingle();
    if (existing) {
      resolvedGymId = existing.id;
      // Claims carry the DB truth — a stale request name must not diverge
      // the token from the fleet row. Keep gyms.tier on the newest license.
      resolvedName = existing.name;
      if (existing.tier !== tier) await supa.from("gyms").update({ tier }).eq("id", existing.id);
    }
  }
  if (!resolvedGymId) {
    if (!create_gym && gym_id) return new Response("gym not found", { status: 404 });
    const { data: created, error: createErr } = await supa
      .from("gyms")
      .insert({ name: resolvedName, tier })
      .select("id")
      .single();
    if (createErr) {
      console.error("gym create", createErr.message);
      return new Response("gym create failed", { status: 500 });
    }
    resolvedGymId = created.id;
    await supa.from("audit_logs").insert({
      gym_id: resolvedGymId,
      actor: user.email ?? "ceo",
      action: "gym.create",
      meta: { via: "license-issue", name: resolvedName, tier },
    });
  }

  const now = new Date();
  const exp = new Date(now.getTime() + days * 86400_000);
  const price = TIERS[tier].usd;
  const claims = {
    license_id: crypto.randomUUID(),
    gym_id: resolvedGymId,
    gym_name: resolvedName,
    owner_email,
    tier,
    issued_at: now.toISOString(),
    expires_at: exp.toISOString(),
    max_members: TIERS[tier].max,
    hardware_lock_enabled: true,
    hwid,
    ip_hint: "",
    exp_unix: Math.floor(exp.getTime() / 1000),
    grace_until: Math.floor(exp.getTime() / 1000) + 3 * 86400,
  };

  const pem = Deno.env.get("RSA_PRIVATE_KEY_PEM");
  if (!pem) return new Response("server key not configured", { status: 500 });
  if (!pem.includes("BEGIN PRIVATE KEY") && !pem.includes("BEGIN RSA PRIVATE KEY")) {
    return new Response("RSA_PRIVATE_KEY_PEM is not a PEM private key", { status: 500 });
  }
  let token: string;
  try {
    const key = await importPrivateKey(pem);
    const msg = new TextEncoder().encode(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign(PSS, key, msg.buffer as ArrayBuffer));
    token = `GPOS-${b64url.encode(msg)}.${b64url.encode(sig)}`;
  } catch (e) {
    return new Response(`sign failed: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
  }

  const { error } = await supa.from("licenses").insert({
    id: claims.license_id,
    gym_id: resolvedGymId,
    raw_token: token,
    revoked: false,
    expires_at: claims.expires_at,
    tier,
    owner_email,
    issued_by: user.email ?? "ceo",
    price_usd: price,
    days_valid: days,
  });
  if (error) {
    console.error("license insert", error.message);
    return new Response("license issue failed", { status: 500 });
  }

  const { error: auditErr } = await supa.from("audit_logs").insert({
    gym_id: resolvedGymId,
    actor: user.email ?? "ceo",
    action: "license.issue",
    license_id: claims.license_id,
    reason: `${tier} · ${days}d · $${price}/mo`,
    meta: { tier, days, price_usd: price, owner_email },
  });
  if (auditErr) console.error("audit", auditErr.message);

  // Full token shown ONCE — dashboard must mask afterwards (Key Vault lists metadata only).
  return Response.json({
    token,
    license_id: claims.license_id,
    gym_id: resolvedGymId,
    expires_at: claims.expires_at,
    tier,
    price_usd: price,
    days_valid: days,
  });
});
