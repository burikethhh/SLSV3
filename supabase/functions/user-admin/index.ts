// CEO account directory and atomic, audited facility assignments.
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";
import { needsMfa } from "../_shared/assurance.ts";
import { UUID_RE } from "../_shared/entitlement.ts";

serve(async req => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user: caller } } = await supa.auth.getUser(jwt);
  if (!caller || !caller.email_confirmed_at || caller.app_metadata.role !== "ceo") return new Response("Verified CEO required", { status: 403 });
  if (needsMfa(caller, jwt)) return new Response("Complete two-factor verification", { status: 403 });
  const rl = check(`user-admin:${caller.id}`, 120, 3600);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);
  let body;
  try { body = await req.json(); } catch { return new Response("Invalid request", { status: 400 }); }
  if (body.action === "list") {
    const page = Number(body.page ?? 1);
    if (!Number.isSafeInteger(page) || page < 1) return new Response("Invalid page", { status: 400 });
    const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 100 });
    if (error) return new Response("Account directory unavailable", { status: 503 });
    return Response.json({ users: data.users.map(u => ({ user_id: u.id, email: u.email, role: u.app_metadata.role ?? null,
      gym_ids: u.app_metadata.gym_ids ?? [], verified: !!u.email_confirmed_at })), page, has_more: data.users.length === 100 });
  }
  const role = body.role;
  if (role !== null && !["owner", "manager", "ceo"].includes(role)) return new Response("Invalid role", { status: 400 });
  const gyms = body.gym_ids ?? [];
  if (!Array.isArray(gyms) || gyms.some(g => typeof g !== "string" || !UUID_RE.test(g))) return new Response("Invalid facility selection", { status: 400 });
  let target = typeof body.user_id === "string" ? body.user_id : "";
  if (!target) {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!email) return new Response("Account email required", { status: 400 });
    for (let page = 1; page <= 500; page++) {
      const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 200 });
      if (error) return new Response("Account lookup unavailable", { status: 503 });
      target = data.users.find(u => u.email?.toLowerCase() === email)?.id ?? "";
      if (target || data.users.length < 200) break;
      if (page === 500) return new Response("Directory too large; select the account from its page", { status: 503 });
    }
  }
  if (!UUID_RE.test(target)) return new Response("Account not found; ask them to register and verify their email first", { status: 404 });
  const { error } = await supa.rpc("set_dashboard_access", { p_actor: caller.id, p_target: target, p_role: role, p_gyms: [...new Set(gyms)] });
  if (error) return new Response(["Cannot remove the last CEO", "Target must verify their email first", "Select at least one facility", "Unknown facility assignment"].find(message => error.message.includes(message)) ?? "Account update rejected", { status: 409 });
  return Response.json({ ok: true, user_id: target, role });
});
