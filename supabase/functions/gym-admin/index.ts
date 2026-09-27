// Gym admin — CEO-only. Create a gym (needed before license-issue FK) or
// toggle the kill-switch (gyms.disabled). Both write audit rows via service_role.
// POST { action: "create"|"set_disabled", gym_id?, name?, tier?, disabled?, reason? }
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";

const TIERS = new Set(["basic", "pro", "ultra"]);
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
    if (!name || !TIERS.has(tier)) return new Response("name + valid tier required", { status: 400 });
    const { data: gym, error } = await supa
      .from("gyms")
      .insert({ name, tier })
      .select("id, name, tier, disabled")
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

  if (action === "set_disabled") {
    const gym_id = body.gym_id;
    if (!gym_id || !UUID_RE.test(String(gym_id))) return new Response("gym_id required", { status: 400 });
    if (typeof body.disabled !== "boolean") return new Response("disabled must be boolean", { status: 400 });
    const disabled = body.disabled;
    const reason = String(body.reason ?? "").slice(0, 500);

    // Select first — a no-op update on a missing id would report ok:true.
    const { data: gym, error: findErr } = await supa.from("gyms").select("id").eq("id", gym_id).maybeSingle();
    if (findErr) {
      console.error("gym find", findErr.message);
      return new Response("gym lookup failed", { status: 500 });
    }
    if (!gym) return new Response("gym not found", { status: 404 });

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
