// CEO payment-confirmed 30-day subscription. No manual key distribution.
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { makeClaims, signEntitlement, TIERS, UUID_RE } from "../_shared/entitlement.ts";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";
import { needsMfa } from "../_shared/assurance.ts";

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user || user.app_metadata?.role !== "ceo") return new Response("CEO only", { status: 403 });
  if (needsMfa(user, jwt)) return new Response("Complete two-factor verification", { status: 403 });
  const rl = check(`license-issue:${user.id}`, 30, 3600);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);
  let body;
  try { body = await req.json(); } catch { return new Response("Invalid request", { status: 400 }); }
  const gymId = String(body.gym_id ?? "");
  const tier = String(body.tier ?? "");
  const reference = String(body.payment_reference ?? "").trim().slice(0, 500);
  if (!UUID_RE.test(gymId) || !TIERS[tier] || body.payment_confirmed !== true || reference.length < 3)
    return new Response("Select a facility and tier, confirm payment, and enter a payment reference", { status: 400 });
  const { data: gym, error } = await supa.from("gyms").select("id,name,status,disabled,owner_email").eq("id", gymId).maybeSingle();
  if (error) return new Response("Facility lookup unavailable", { status: 503 });
  if (!gym) return new Response("Facility not found", { status: 404 });
  if (gym.status !== "active" || gym.disabled) return new Response("Approve and enable this facility first", { status: 409 });
  const { data: previous, error: previousError } = await supa.from("licenses").select("id,expires_at,is_trial,revoked").eq("gym_id", gymId)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (previousError) return new Response("Subscription lookup unavailable", { status: 503 });
  if ((body.previous_license_id ?? null) !== (previous?.id ?? null)) return new Response("Subscription changed. Refresh before confirming again.", { status: 409 });
  // Renew early without losing paid days; replacing a free trial starts today.
  const start = previous && !previous.is_trial && !previous.revoked ? Math.max(Date.now(), Date.parse(previous.expires_at)) : Date.now();
  const expires = new Date(start + 30 * 86400_000);
  const id = crypto.randomUUID();
  try {
    const token = await signEntitlement(makeClaims(gym, id, tier, expires));
    const { error: activationError } = await supa.rpc("activate_paid_subscription", {
      p_gym: gym.id, p_previous: previous?.id ?? null, p_license: id, p_token: token,
      p_tier: tier, p_expires: expires.toISOString(), p_price: TIERS[tier].usd,
      p_actor: user.email ?? "CEO", p_reference: reference,
    });
    if (activationError) return new Response("Activation not committed. Refresh subscription before retrying.", { status: 409 });
    return Response.json({ ok: true, license_id: id, gym_id: gym.id, expires_at: expires.toISOString(), days_valid: 30 });
  } catch { return new Response("Subscription signing unavailable; no subscription was activated.", { status: 503 }); }
});
