// Terminal sync Edge Function — replaces v2 Axum POST /api/v1/sync/push.
// Auth: Bearer = raw GPOS-<claims>.<sig> license token (verified, not a JWT).
// Uses service_role internally (terminals have no Supabase user session).
//
// POST { attendance: [], sales: [], members: [] }
//   -> { remote_disabled, products, product_ids, server_time }
//
// Contract (matches desktop sync_worker + db.rs):
// - Idempotent: members/attendance/sales UPSERT by id — a retried batch after
//   a lost response can never duplicate rows (was: insert → PK conflict →
//   permanent 502 → outbox wedge).
// - Attendance/sales carry client ids + created_at (offline timestamps).
// - Caps: each array ≤ 500, body ≤ 512 KiB, per-IP 300/min.
// - product_ids = full id list (≤5000) so the terminal can DELETE local
//   products the owner removed; products = first 500 with detail for upsert.
// - Kill-switch FAIL-CLOSED: missing gym/license row OR disabled/revoked
//   → remote_disabled=true (never trust a row we can't find).
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { importPublicKey, PSS, b64url } from "../_shared/licenseCrypto.ts";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";

const ARRAY_CAP = 500;
const BODY_CAP = 512 * 1024;
const PRODUCT_IDS_CAP = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v : null);

function parseLicense(token: string): { ok: true; msg: Uint8Array; sig: Uint8Array } | { ok: false } {
  const clean = String(token ?? "").replace(/\s+/g, "");
  if (!clean.startsWith("GPOS-")) return { ok: false };
  const rest = clean.slice(5);
  const dot = rest.indexOf(".");
  if (dot < 1) return { ok: false };
  try {
    return { ok: true, msg: b64url.decode(rest.slice(0, dot)), sig: b64url.decode(rest.slice(dot + 1)) };
  } catch {
    return { ok: false };
  }
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // Generous IP limit — terminals poll at 5–60s backoff; NAT'd gyms stack a
  // handful of devices. Blocks token-guessing floods without touching uptime.
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",").pop()!.trim();
  const rl = check(`sync:${ip}`, 300, 60);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > BODY_CAP) return new Response("body too large", { status: 413 });

  const auth = parseLicense((req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, ""));
  if (!auth.ok) return new Response("bad license", { status: 401 });

  const pubPem = Deno.env.get("RSA_PUBLIC_KEY_PEM");
  if (!pubPem) return new Response("server key not configured", { status: 500 });
  // Re-verify signature server-side (fail-closed, same as license-verify).
  const ok = await crypto.subtle.verify(
    PSS,
    await importPublicKey(pubPem),
    auth.sig.buffer as ArrayBuffer,
    auth.msg.buffer as ArrayBuffer,
  );
  if (!ok) return new Response("bad signature", { status: 401 });

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(auth.msg));
  } catch {
    return new Response("bad claims", { status: 401 });
  }
  const gymId = asUuid(claims.gym_id);
  const licenseId = asUuid(claims.license_id);
  if (!gymId || !licenseId) return new Response("bad claims", { status: 401 });

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Kill-switch check FIRST: missing row / disabled gym / revoked license all
  // stop the push path (fail-closed — a row we can't find is a dead license).
  const [{ data: gym }, { data: lic }] = await Promise.all([
    supa.from("gyms").select("disabled").eq("id", gymId).maybeSingle(),
    supa.from("licenses").select("revoked").eq("id", licenseId).maybeSingle(),
  ]);
  if (!gym || !lic || gym.disabled || lic.revoked) {
    return Response.json({ remote_disabled: true, products: [], product_ids: [], server_time: Date.now() });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const attendance = Array.isArray(body.attendance) ? body.attendance : [];
  const sales = Array.isArray(body.sales) ? body.sales : [];
  const members = Array.isArray(body.members) ? body.members : [];
  if (attendance.length > ARRAY_CAP || sales.length > ARRAY_CAP || members.length > ARRAY_CAP) {
    return new Response("batch too large", { status: 413 });
  }

  // Members first (same batch) so attendance.member_id FK resolves.
  for (const m of members) {
    const id = asUuid((m as Record<string, unknown>)?.id);
    if (!id) continue;
    const row = m as Record<string, unknown>;
    const { error } = await supa.from("members").upsert(
      {
        id,
        gym_id: gymId,
        full_name: String(row.full_name ?? "").slice(0, 200),
        embedding_dim: Number(row.embedding_dim ?? 512),
        face_vector: row.face_vector ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) {
      console.error("member upsert", error.message);
      return Response.json({ remote_disabled: false, error: "member upsert failed" }, { status: 502 });
    }
  }

  let skipped = 0;
  const writes: Promise<unknown>[] = [];

  for (const raw of attendance) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const id = asUuid(a.id);
    if (!id) { skipped++; continue; } // no client id = can't dedupe retries
    writes.push(
      supa.from("attendance").upsert(
        {
          id,
          gym_id: gymId,
          member_id: asUuid(a.member_id),
          direction: "in",
          confidence: a.confidence ?? null,
          created_at: typeof a.created_at === "string" && a.created_at ? a.created_at : new Date().toISOString(),
        },
        { onConflict: "id" },
      ),
    );
  }
  for (const raw of sales) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const id = asUuid(s.id);
    if (!id) { skipped++; continue; }
    let items: unknown;
    try {
      items = typeof s.items_json === "string" ? JSON.parse(s.items_json) : s.items;
    } catch {
      skipped++;
      continue;
    }
    writes.push(
      supa.from("sales").upsert(
        {
          id,
          gym_id: gymId,
          items: Array.isArray(items) ? items : [],
          total_cents: Number(s.total_cents ?? 0),
          pay_method: String(s.pay_method ?? "cash"),
          created_at: typeof s.created_at === "string" && s.created_at ? s.created_at : new Date().toISOString(),
        },
        { onConflict: "id" },
      ),
    );
  }
  const results = await Promise.all(writes);
  const failures = results.filter((r) => (r as { error?: unknown }).error);
  if (failures.length) {
    for (const f of failures.slice(0, 3)) console.error("push insert", (f as { error?: { message?: string } }).error?.message);
    return Response.json({ remote_disabled: false, error: "insert failed", count: failures.length }, { status: 502 });
  }

  // Pull side: catalog for this gym (owner edits land on terminal next poll).
  // product_ids is the FULL list — terminal deletes locals missing from it.
  // staff = terminal PIN cache (PHC pin_hash; verified offline on-device).
  const [products, productIds, staff] = await Promise.all([
    supa.from("products").select("id,name,price_cents,stock").eq("gym_id", gymId).limit(500),
    supa.from("products").select("id").eq("gym_id", gymId).limit(PRODUCT_IDS_CAP),
    supa.from("staff").select("id,username,pin_hash,role,active").eq("gym_id", gymId).limit(100),
  ]);
  if (products.error || productIds.error || staff.error) {
    console.error("pull", products.error?.message ?? productIds.error?.message ?? staff.error?.message);
    return Response.json({ remote_disabled: false, error: "pull failed" }, { status: 502 });
  }

  return Response.json({
    remote_disabled: false,
    products: products.data ?? [],
    product_ids: (productIds.data ?? []).map((p) => p.id as string),
    staff: staff.data ?? [],
    skipped,
    server_time: Date.now(),
  });
});
