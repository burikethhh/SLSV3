// Verified-email onboarding. User metadata carries a draft, never privileges.
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";
import { makeClaims, signEntitlement, TIERS } from "../_shared/entitlement.ts";

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user?.email) return new Response("Sign in first", { status: 401 });
  if (!user.email_confirmed_at) return new Response("Verify your email before starting the trial", { status: 403 });
  if (user.app_metadata?.role && user.app_metadata.role !== "owner") return new Response("Owner registration only", { status: 403 });
  const rl = check(`owner-apply:${user.id}`, 10, 3600);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);
  const { data: existing, error: findError } = await supa.from("gyms").select("id,name,status")
    .eq("owner_user_id", user.id).order("created_at").limit(1).maybeSingle();
  if (findError) return new Response("Application lookup failed", { status: 503 });
  let body;
  try { body = await req.json(); } catch { return new Response("Invalid application", { status: 400 }); }
  const draft = user.user_metadata?.onboarding ?? {};
  const name = String(body.gym_name ?? draft.gym_name ?? existing?.name ?? "").trim();
  const location = String(body.location ?? draft.location ?? "").trim();
  const tier = String(body.tier ?? draft.tier ?? "basic");
  if (!name || name.length > 200 || location.length > 200 || !TIERS[tier]) return new Response("Gym name and a valid tier are required", { status: 400 });
  const gym = { id: crypto.randomUUID(), name, owner_email: user.email };
  const license = crypto.randomUUID();
  const expires = new Date(Date.now() + 14 * 86400_000);
  try {
    const token = await signEntitlement(makeClaims(gym, license, tier, expires));
    const { data: gymId, error } = await supa.rpc("provision_owner_trial", {
      p_user: user.id, p_gym: gym.id, p_name: name, p_location: location, p_tier: tier,
      p_license: license, p_token: token, p_expires: expires.toISOString(),
    });
    if (error) throw error;
    return Response.json({ ok: true, gym_id: gymId, status: "pending" });
  } catch {
    return new Response("Could not complete gym setup. Your account is saved; please retry.", { status: 503 });
  }
});
