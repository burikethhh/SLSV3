// License revoke — CEO-only Edge Function (service_role write + full audit).
// POST { license_id, reason? } -> { ok, license_id }
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";
import { needsMfa } from "../_shared/assurance.ts";

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",").pop()!.trim();

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user || (user.app_metadata as { role?: string }).role !== "ceo") {
    return new Response("ceo only", { status: 403 });
  }
  const rl = check(`license-revoke:${ip}`, 30, 3600);
  if (needsMfa(user, jwt)) return new Response("Complete two-factor verification", { status: 403 });
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const { license_id, reason = "" } = await req.json();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!license_id || !UUID_RE.test(String(license_id))) return new Response("license_id required", { status: 400 });

  const { data: lic, error: findErr } = await supa
    .from("licenses")
    .select("id, gym_id")
    .eq("id", license_id)
    .maybeSingle();
  if (findErr) {
    console.error("license find", findErr.message);
    return new Response("revoke failed", { status: 500 });
  }
  if (!lic) return new Response("license not found", { status: 404 });

  const { error } = await supa.from("licenses").update({ revoked: true }).eq("id", license_id);
  if (error) {
    console.error("license revoke", error.message);
    return new Response("revoke failed", { status: 500 });
  }

  const { error: auditErr } = await supa.from("audit_logs").insert({
    gym_id: lic.gym_id,
    actor: user.email ?? "ceo",
    action: "license.revoke",
    license_id,
    reason: String(reason).slice(0, 500),
  });
  if (auditErr) console.error("audit", auditErr.message);

  return Response.json({ ok: true, license_id });
});
