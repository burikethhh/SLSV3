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
import { readSnapshot } from "../_shared/snapshot.ts";

const ARRAY_CAP = 500;
const BODY_CAP = 512 * 1024;
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
  const [{ data: gym, error: gymError }, { data: lic, error: licenseError }] = await Promise.all([
    supa.from("gyms").select("disabled,status").eq("id", gymId).maybeSingle(),
    supa.from("licenses").select("revoked,expires_at").eq("id", licenseId).eq("gym_id", gymId).maybeSingle(),
  ]);
  if (gymError || licenseError) return new Response("Verification temporarily unavailable", { status: 503 });
  const graceMs = 3 * 86400_000;
  const expMs = lic?.expires_at ? Date.parse(lic.expires_at as string) : NaN;
  const pastGrace = Number.isFinite(expMs) ? Date.now() > expMs + graceMs : true;
  if (!gym || !lic || gym.disabled || gym.status === "rejected" || lic.revoked || pastGrace) {
    return Response.json({ remote_disabled: true, products: [], product_ids: [], server_time: Date.now() });
  }

  if (claims.device_id) {
    const { data: terminal, error: deviceError } = await supa.from("terminals").select("active,hwid")
      .eq("id", claims.device_id).eq("gym_id", gymId).maybeSingle();
    if (deviceError) return new Response("Device verification unavailable", { status: 503 });
    const accountId = asUuid(claims.account_id);
    if (!accountId) return new Response("Invalid device account", { status: 401 });
    const { data: account, error: accountError } = await supa.auth.admin.getUserById(accountId);
    if (accountError) return new Response("Account verification unavailable", { status: 503 });
    if (!terminal?.active || terminal.hwid !== claims.hwid || account.user?.app_metadata?.role !== "owner"
      || !account.user?.app_metadata?.gym_ids?.includes(gymId)) {
      return Response.json({ remote_disabled: true, products: [], product_ids: [], server_time: Date.now() });
    }
  }

  let body: Record<string, unknown>;
  try {
    const rawBody=await req.text();
    if(new TextEncoder().encode(rawBody).length>BODY_CAP) return new Response("body too large",{status:413});
    body = JSON.parse(rawBody);
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
  const acceptedIds: string[] = [];
  const failedIds: string[] = [];
  for (const m of members) {
    const id = asUuid((m as Record<string, unknown>)?.id);
    if (!id) continue;
    const row = m as Record<string, unknown>;
    const vector=row.face_vector;
    const expires=typeof row.expires_at==="string"?row.expires_at:null;
    if(!Array.isArray(vector)||vector.length!==512||vector.some(v=>typeof v!=="number"||!Number.isFinite(v))
      ||(expires!==null&&!Number.isFinite(Date.parse(expires)))) {failedIds.push(id);continue;}
    const {error}=await supa.rpc("sync_member_enrollment",{p_gym:gymId,p_member:id,
      p_name:String(row.full_name??"").slice(0,200),p_vector:vector,p_expires:expires});
    if (error) {
      console.error("member upsert", error.message);
      failedIds.push(id);
    } else acceptedIds.push(id);
  }

  const writes: { id: string; result: PromiseLike<{ error: { message: string } | null }> }[] = [];

  for (const raw of attendance) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const id = asUuid(a.id);
    if (!id) continue; // no client id = can't dedupe retries
    writes.push({ id, result:
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
    });
  }
  for (const raw of sales) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const id = asUuid(s.id);
    if (!id) continue;
    let items: unknown;
    try {
      items = typeof s.items_json === "string" ? JSON.parse(s.items_json) : s.items;
    } catch {
      failedIds.push(id);
      continue;
    }
    // Fix 2: recompute the total from line items — a stolen license token
    // could previously push any peso figure and the dashboard reported it.
    // Reject the entire sale if any line is invalid: dropping just one line
    // would silently alter the cashier's completed transaction.
    const lines = Array.isArray(items) ? items : [];
    const cleanLines: { product_id: string | null; qty: number; unit_cents: number; discount_cents?: number }[] = [];
    let invalidLine = false;
    for (const it of lines) {
      const r = (it ?? {}) as Record<string, unknown>;
      const qty = Number(r.qty ?? 0);
      const unit = Number(r.unit_cents ?? 0);
      if (!Number.isSafeInteger(qty) || !Number.isSafeInteger(unit) || qty <= 0 || unit < 0 || !asUuid(r.product_id)) {
        invalidLine = true;
        break;
      }
      if (qty > 999 || unit > 100_000_00) { invalidLine = true; break; } // sanity caps per line
      const rawDiscount = Number(r.discount_cents ?? 0);
      if (!Number.isSafeInteger(rawDiscount) || rawDiscount < 0 || rawDiscount > qty * unit) {
        invalidLine = true;
        break;
      }
      const discount = rawDiscount;
      cleanLines.push({ product_id: asUuid(r.product_id), qty, unit_cents: unit, discount_cents: discount });
    }
    if (invalidLine || !cleanLines.length) { failedIds.push(id); continue; }
    const computed = cleanLines.reduce((a, l) => a + Math.max(0, l.qty * l.unit_cents - (l.discount_cents ?? 0)), 0);
    const claimed = Number(s.total_cents ?? NaN);
    if (!Number.isSafeInteger(claimed) || claimed <= 0 || claimed !== computed) {
      failedIds.push(id);
      continue;
    }
    writes.push({ id, result:
      supa.rpc("record_sale_and_decrement_stock", {
        p_sale_id: id,
        p_gym_id: gymId,
        p_items: cleanLines,
        p_total_cents: computed,
        p_pay_method: asPayMethod(s.pay_method),
        p_created_at: typeof s.created_at === "string" && s.created_at ? s.created_at : new Date().toISOString(),
      }),
    });
  }
  const results = await Promise.all(writes.map((write) => write.result));
  for (let i = 0; i < results.length; i++) {
    if (results[i].error) {
      console.error("push insert", results[i].error?.message);
      failedIds.push(writes[i].id);
    } else acceptedIds.push(writes[i].id);
  }

  // Pull side: catalog for this gym (owner edits land on terminal next poll).
  // product_ids is the FULL list — terminal deletes locals missing from it.
  // staff = terminal PIN cache (PHC pin_hash; verified offline on-device).
  // promos = active discount vouchers for this gym or global templates.
  // members = active member status & plan expiration dates for gate guard.
  const cutoff=new Date().toISOString();
  const requestedSince=typeof body.face_since==="string"?Date.parse(body.face_since):0;
  const since=Number.isFinite(requestedSince)&&requestedSince>=0&&requestedSince<=Date.now()?new Date(requestedSince).toISOString():new Date(0).toISOString();
  const pull=(table:string,columns:string,global=false,faces=false)=>readSnapshot((after,size)=> {
    let query=supa.from(table).select(columns).order("id").limit(size);
    query=global?query.or(`gym_id.is.null,gym_id.eq.${gymId}`):query.eq("gym_id",gymId);
    if(after)query=query.gt("id",after);
    if(table==="staff"||table==="promos")query=query.eq("active",true);
    if(table==="members")query=query.is("deleted_at",null);
    if(faces)query=query.eq("embedding_dim",512).gte("updated_at",since).lte("updated_at",cutoff);
    return query as unknown as PromiseLike<{data:({id:string}&Record<string,unknown>)[]|null;error:unknown}>;
  });
  try {
    const [products,staff,promos,membersList,plans,faces]=await Promise.all([
      pull("products","id,name,price_cents,stock"),pull("staff","id,username,pin_hash,role,active"),
      pull("promos","id,gym_id,code,pct_off,active",true),pull("members","id,full_name,status,expires_at"),
      pull("plans","id,name,price_cents,duration_days",true),pull("members","id,embedding_dim,face_vector",false,true),
    ]);
    return Response.json({remote_disabled:false,catalog_complete:true,products,product_ids:products.map(p=>p.id),
      staff,promos:promos.sort((a,b)=>Number(a.gym_id!==null)-Number(b.gym_id!==null)),members:membersList,
      plans,face_changes:faces,face_cursor:cutoff,accepted_ids:acceptedIds,failed_ids:failedIds,server_time:Date.now()});
  } catch { return Response.json({remote_disabled:false,error:"Complete pull unavailable"},{status:503}); }
});

