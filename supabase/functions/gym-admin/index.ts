// CEO application review is independent of payment/subscription activation.
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";
import { TIERS, UUID_RE } from "../_shared/entitlement.ts";
import { needsMfa } from "../_shared/assurance.ts";

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user || user.app_metadata?.role !== "ceo") return new Response("CEO only", { status: 403 });
  if (needsMfa(user, jwt)) return new Response("Complete two-factor verification", { status: 403 });
  const rl = check(`gym-admin:${user.id}`, 60, 3600);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);
  let body;
  try { body = await req.json(); } catch { return new Response("Invalid request", { status: 400 }); }
  const action = String(body.action ?? "");
  const reason = String(body.reason ?? "").slice(0, 500);
  if (action === "create") {
    const name = String(body.name ?? "").trim();
    const tier = String(body.tier ?? "basic");
    if (!name || name.length > 200 || !TIERS[tier]) return new Response("Name and valid tier required", { status: 400 });
    const { data: gym, error } = await supa.from("gyms").insert({ name, tier, status: "active" }).select("id,name,tier,status").single();
    if (error) return new Response("Could not create facility", { status: 503 });
    await supa.from("audit_logs").insert({ gym_id: gym.id, actor: user.email ?? "CEO", action: "gym.create" });
    return Response.json({ ok: true, gym });
  }
  if (action === "set_terminal_active") {
    if (!UUID_RE.test(String(body.terminal_id)) || typeof body.active !== "boolean") return new Response("Terminal and active flag required", { status: 400 });
    const { data: device, error } = await supa.from("terminals").update({ active: body.active }).eq("id", body.terminal_id).select("id,gym_id").maybeSingle();
    if (error) return new Response("Terminal update unavailable", { status: 503 });
    if (!device) return new Response("Terminal not found", { status: 404 });
    await supa.from("audit_logs").insert({ gym_id: device.gym_id, actor: user.email ?? "CEO", action: body.active ? "terminal.enable" : "terminal.revoke", reason, meta: { terminal_id: device.id } });
    return Response.json({ ok: true });
  }
  if (!UUID_RE.test(String(body.gym_id))) return new Response("Valid facility required", { status: 400 });
  if (action === "approve_application" || action === "reject_application") {
    const approved = action === "approve_application";
    const { data: gym, error } = await supa.from("gyms")
      .update({ status: approved ? "active" : "rejected", approved_at: approved ? new Date().toISOString() : null })
      .eq("id", body.gym_id).eq("status", "pending").select("id").maybeSingle();
    if (error) return new Response("Application update unavailable", { status: 503 });
    if (!gym) return new Response("Application already processed or not found", { status: 409 });
    await supa.from("audit_logs").insert({ gym_id: gym.id, actor: user.email ?? "CEO", action: approved ? "gym.approve_application" : "gym.reject_application", reason: reason || (approved ? "Facility approved. Payment not yet confirmed." : "Application rejected.") });
    return Response.json({ ok: true, status: approved ? "active" : "rejected" });
  }
  if (action === "set_disabled") {
    if (typeof body.disabled !== "boolean") return new Response("Disabled flag required", { status: 400 });
    const { data: gym, error } = await supa.from("gyms").update({ disabled: body.disabled }).eq("id", body.gym_id).select("id").maybeSingle();
    if (error) return new Response("Facility update unavailable", { status: 503 });
    if (!gym) return new Response("Facility not found", { status: 404 });
    await supa.from("audit_logs").insert({ gym_id: gym.id, actor: user.email ?? "CEO", action: body.disabled ? "gym.kill" : "gym.enable", reason });
    return Response.json({ ok: true });
  }
  return new Response("Unknown action", { status: 400 });
});
