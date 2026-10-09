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
// - Kill-switch FAIL-CLOSED: missing gym/license row, disabled/revoked, or
//   past the 3-day expiry grace → remote_disabled=true
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { importPublicKey, PSS, b64url } from "../_shared/licenseCrypto.ts";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";

const ARRAY_CAP = 500;
const BODY_CAP = 512 * 1024;
const PRODUCT_IDS_CAP = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v : null);

// Fix 2+3: allowlisted tender types — typos used to split revenue reports.
const PAY_METHODS = new Set(["cash", "gcash", "maya", "card", "qrph", "bank"]);
const asPayMethod = (v: unknown): string => {
  const m = String(v ?? "cash").trim().toLowerCase();
  return PAY_METHODS.has(m) ? m : "cash";
};

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
  // Expiry uses the same 3-day grace as the desktop evaluator
  // (sls-core LicenseClaims::evaluate) and fleet_mrr, so a terminal in its
  // grace window can still push while the dashboard shows it as grace.
  const [{ data: gym }, { data: lic }] = await Promise.all([
    supa.from("gyms").select("disabled").eq("id", gymId).maybeSingle(),
    supa.from("licenses").select("revoked,expires_at").eq("id", licenseId).maybeSingle(),
  ]);
  const graceMs = 3 * 86400_000;
  const expMs = lic?.expires_at ? Date.parse(lic.expires_at as string) : NaN;
  const pastGrace = Number.isFinite(expMs) ? Date.now() > expMs + graceMs : true;
  if (!gym || !lic || gym.disabled || lic.revoked || pastGrace) {
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
          direction: (typeof a.direction === "string" && (a.direction === "out" || a.direction === "in")) ? a.direction : "in",
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
    // Fix 2: recompute the total from line items — a stolen license token
    // could previously push any peso figure and the dashboard reported it.
    // Unknown/negative lines are dropped; a >1-peso mismatch is rejected.
    const lines = Array.isArray(items) ? items : [];
    const cleanLines: { product_id: string | null; qty: number; unit_cents: number; discount_cents?: number }[] = [];
    for (const it of lines) {
      const r = (it ?? {}) as Record<string, unknown>;
      const qty = Math.floor(Number(r.qty ?? 0));
      const unit = Math.floor(Number(r.unit_cents ?? 0));
      if (!Number.isFinite(qty) || !Number.isFinite(unit) || qty <= 0 || unit < 0) continue;
      if (qty > 999 || unit > 100_000_00) continue; // sanity caps per line
      const rawDiscount = Math.floor(Number(r.discount_cents ?? 0));
      const discount = Number.isFinite(rawDiscount) && rawDiscount > 0 ? Math.min(qty * unit, rawDiscount) : 0;
      cleanLines.push({ product_id: asUuid(r.product_id), qty, unit_cents: unit, discount_cents: discount });
    }
    if (!cleanLines.length) { skipped++; continue; }
    const computed = cleanLines.reduce((a, l) => a + Math.max(0, l.qty * l.unit_cents - (l.discount_cents ?? 0)), 0);
    const claimed = Math.floor(Number(s.total_cents ?? NaN));
    // Tolerate sub-peso rounding from old terminals, reject anything bigger.
    if (!Number.isFinite(claimed) || claimed < 0 || Math.abs(claimed - computed) > 100) {
      skipped++;
      continue;
    }
    writes.push(
      supa.from("sales").upsert(
        {
          id,
          gym_id: gymId,
          items: cleanLines,
          total_cents: computed,
          pay_method: asPayMethod(s.pay_method),
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
  // promos = active discount vouchers for this gym or global templates.
  // members = active member status & plan expiration dates for gate guard.
  const [products, productIds, staff, promos, membersList] = await Promise.all([
    supa.from("products").select("id,name,price_cents,stock").eq("gym_id", gymId).limit(500),
    supa.from("products").select("id").eq("gym_id", gymId).limit(PRODUCT_IDS_CAP),
    supa.from("staff").select("id,username,pin_hash,role,active").eq("gym_id", gymId).eq("active", true).limit(100),
    supa.from("promos").select("code,pct_off,active").or(`gym_id.is.null,gym_id.eq.${gymId}`).eq("active", true).limit(100),
    supa.from("members").select("id,full_name,status,expires_at").eq("gym_id", gymId).is("deleted_at", null).limit(500),
  ]);
  if (products.error || productIds.error || staff.error || promos.error || membersList.error) {
    console.error("pull", products.error?.message ?? productIds.error?.message ?? staff.error?.message ?? promos.error?.message ?? membersList.error?.message);
    return Response.json({ remote_disabled: false, error: "pull failed" }, { status: 502 });
  }

  return Response.json({
    remote_disabled: false,
    products: products.data ?? [],
    product_ids: (productIds.data ?? []).map((p) => p.id as string),
    staff: staff.data ?? [],
    promos: promos.data ?? [],
    members: membersList.data ?? [],
    skipped,
    server_time: Date.now(),
  });
});

