// First-CEO bootstrap. POST {} with a valid Supabase Auth JWT.
// If NO user in the project has app_metadata.role=ceo yet, grants it to the caller.
// Afterwards returns 403 (further CEOs are created by a CEO via dashboard/user-admin).
// Rate-limited 5/hour per IP (same as orig ceo-register).
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",").pop()!.trim();
  const rl = check(`bootstrap-ceo:${ip}`, 5, 3600);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user) return new Response("auth required", { status: 401 });

  // Does a CEO already exist? Page through users checking app_metadata.
  let page = 1;
  let ceoExists = false;
  for (;;) {
    const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 100 });
    if (error) {
      console.error("listUsers", error.message);
      return new Response("bootstrap failed", { status: 500 });
    }
    if (data.users.some((u) => (u.app_metadata as { role?: string })?.role === "ceo")) {
      ceoExists = true;
      break;
    }
    if (data.users.length < 100) break;
    page++;
  }
  if (ceoExists) return new Response("ceo already exists", { status: 403 });

  const { error } = await supa.auth.admin.updateUserById(user.id, {
    app_metadata: { ...user.app_metadata, role: "ceo", gym_ids: [] },
  });
  if (error) {
    console.error("grant ceo", error.message);
    return new Response("bootstrap failed", { status: 500 });
  }

  const { error: auditErr } = await supa.from("audit_logs").insert({
    actor: user.email ?? "ceo",
    action: "ceo.bootstrap",
    reason: user.email ?? user.id,
  });
  if (auditErr) console.error("audit", auditErr.message);
  return Response.json({ ok: true, email: user.email });
});
