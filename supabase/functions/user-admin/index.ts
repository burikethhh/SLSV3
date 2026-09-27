// User admin — CEO-only. Provision dashboard RBAC claims on an auth user.
// Self-register creates role=null dead accounts; this grants owner/manager/ceo.
// POST { action: "list" } | { email | user_id, role: "owner"|"manager"|"ceo", gym_ids: uuid[] }
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";

const ROLES = new Set(["owner", "manager", "ceo"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",").pop()!.trim();

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user: caller } } = await supa.auth.getUser(jwt);
  if (!caller || (caller.app_metadata as { role?: string }).role !== "ceo") {
    return new Response("ceo only", { status: 403 });
  }
  const rl = check(`user-admin:${ip}`, 30, 3600);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const body = await req.json();

  // RBAC directory: the CEO Users page needs to SEE who holds which role.
  if (body?.action === "list") {
    const { data, error } = await supa.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (error) {
      console.error("listUsers", error.message);
      return new Response("user list failed", { status: 500 });
    }
    return Response.json({
      users: data.users.map((u) => ({
        user_id: u.id,
        email: u.email,
        role: (u.app_metadata as { role?: string }).role ?? null,
        gym_ids: (u.app_metadata as { gym_ids?: string[] }).gym_ids ?? [],
        created_at: u.created_at,
      })),
      page: data.page,
    });
  }

  const { email, user_id, role, gym_ids = [] } = body;
  // role: null = demote (strip RBAC claims → account can log in but sees nothing).
  if (role !== null && !ROLES.has(role)) return new Response("bad role", { status: 400 });
  if (!email && !user_id) return new Response("email or user_id required", { status: 400 });
  if (!Array.isArray(gym_ids) || gym_ids.some((g: unknown) => !UUID_RE.test(String(g)))) {
    return new Response("gym_ids must be uuid[]", { status: 400 });
  }

  let targetId = user_id as string | undefined;
  if (!targetId) {
    const { data, error } = await supa.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (error) {
      console.error("listUsers", error.message);
      return new Response("user lookup failed", { status: 500 });
    }
    targetId = data.users.find((u) => u.email === email)?.id;
    if (!targetId) return new Response("user not found — have them register first", { status: 404 });
  }

  const { data: target, error: getErr } = await supa.auth.admin.getUserById(targetId);
  if (getErr || !target?.user) return new Response("user not found", { status: 404 });

  const { error } = await supa.auth.admin.updateUserById(targetId, {
    app_metadata: {
      ...target.user.app_metadata,
      role,
      gym_ids: role === null ? [] : gym_ids,
    },
  });
  if (error) {
    console.error("update user", error.message);
    return new Response("user update failed", { status: 500 });
  }

  const { error: auditErr } = await supa.from("audit_logs").insert({
    actor: caller.email ?? "ceo",
    action: role === null ? "user.demote" : `user.${role}`,
    reason: target.user.email ?? targetId,
    meta: { user_id: targetId, role, gym_ids },
  });
  if (auditErr) console.error("audit", auditErr.message);

  return Response.json({ ok: true, user_id: targetId, role, gym_ids });
});
