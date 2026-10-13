// Owner staff-create Edge Function. Owner-only (or CEO). Validates + hashes the
// terminal PIN server-side so plaintext PINs never land in `staff.pin_hash`.
// Hash: Argon2id PHC `$argon2id$v=19$m=19456,t=2,p=1$...` via hash-wasm —
// parameters match `sls-core::auth::hash_password` (argon2::Argon2::default),
// so desktop `verify_password` accepts these hashes with no migration.
// VALIDATE the roundtrip (create here → verify in sls-core test) before production.
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { argon2id } from "npm:hash-wasm@4.12.0";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";
import { needsMfa } from "../_shared/assurance.ts";

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",").pop()!.trim();
  const rl = check(`staff-create:${ip}`, 60, 3600);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  const meta = (user?.app_metadata ?? {}) as { role?: string; gym_ids?: string[] };
  if (!user || (meta.role !== "owner" && meta.role !== "ceo")) {
    return new Response("owner only", { status: 403 });
  }

  const { gym_id, full_name, username, pin, role = "staff" } = await req.json();
  if (needsMfa(user, jwt)) return new Response("Complete two-factor verification", { status: 403 });
  if (!gym_id || !full_name || !username) return new Response("bad fields", { status: 400 });
  const uname = String(username).trim().toLowerCase();
  if (!/^[a-z0-9_.-]{2,32}$/.test(uname)) return new Response("username must be 2-32 chars (a-z 0-9 _ . -)", { status: 400 });
  if (!/^\d{6,12}$/.test(String(pin ?? ""))) return new Response("pin must be 6-12 digits", { status: 400 });
  if (!["staff", "manager"].includes(role)) return new Response("bad role", { status: 400 });
  if (meta.role === "owner" && !(meta.gym_ids ?? []).includes(gym_id)) {
    return new Response("not your gym", { status: 403 });
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const pin_hash = await argon2id({
    password: String(pin),
    salt,
    parallelism: 1,
    iterations: 2,
    memorySize: 19456, // KB — hash-wasm key name (NOT `memory`); matches Argon2::default()
    hashLength: 32,
    outputType: "encoded",
  });

  const { data, error } = await supa.from("staff").insert({
    gym_id,
    full_name: String(full_name).trim().slice(0, 200),
    username: uname,
    pin_hash,
    role,
  }).select("id").single();
  if (error) {
    console.error("staff insert", error.message);
    // 23505 = unique(gym_id, username) — don't leak internals.
    return new Response(error.code === "23505" ? "username already exists" : "staff create failed", { status: 409 });
  }

  const { error: auditErr } = await supa.from("audit_logs").insert({
    gym_id,
    actor: user.email ?? "owner",
    action: "staff.create",
    reason: uname,
    meta: { staff_id: data.id, role },
  });
  if (auditErr) console.error("audit", auditErr.message);
  return Response.json({ id: data.id });
});
