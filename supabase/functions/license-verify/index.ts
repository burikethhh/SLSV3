// SLS v3 license-verify Edge Function. Checks signature + row + revoked + gym kill + expiry.
// POST { token } -> { valid, license_id?, gym_id?, tier?, status?, reason? }
// Rate-limited; uses the PUBLIC key (safe to expose via env, also embedded in desktop).
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";
import { importPublicKey, PSS, b64url } from "../_shared/licenseCrypto.ts";

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",").pop()!.trim();
  const rl = check(`license-verify:${ip}`, 60, 3600);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const { token } = await req.json();
  const clean: string = String(token ?? "").replace(/\s+/g, "");
  const rest = clean.startsWith("GPOS-") ? clean.slice(5) : null;
  const dot = rest?.indexOf(".") ?? -1;
  if (!rest || dot < 1) return Response.json({ valid: false, reason: "malformed" });

  let msg: Uint8Array;
  let sig: Uint8Array;
  try {
    msg = b64url.decode(rest.slice(0, dot));
    sig = b64url.decode(rest.slice(dot + 1));
  } catch {
    return Response.json({ valid: false, reason: "base64" });
  }
  const pubPem = Deno.env.get("RSA_PUBLIC_KEY_PEM");
  if (!pubPem) return new Response("server key not configured", { status: 500 });
  const ok = await crypto.subtle.verify(PSS, await importPublicKey(pubPem), sig.buffer as ArrayBuffer, msg.buffer as ArrayBuffer);
  if (!ok) return Response.json({ valid: false, reason: "signature" });

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(msg));
  } catch {
    return Response.json({ valid: false, reason: "claims" });
  }
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // License row must exist (unknown/forged-but-signed ids fail closed).
  // tier/gym come from the ROW (DB truth), not the token claims.
  const { data: lic } = await supa
    .from("licenses")
    .select("revoked, tier, gym_id")
    .eq("id", String(claims.license_id ?? ""))
    .maybeSingle();
  if (!lic) return Response.json({ valid: false, reason: "not_found" });
  if (lic.revoked) return Response.json({ valid: false, reason: "revoked" });

  // Gym kill-switch (missing row = dead license, fail-closed like sync).
  const { data: gym } = await supa.from("gyms").select("disabled").eq("id", lic.gym_id).maybeSingle();
  if (!gym || gym.disabled) return Response.json({ valid: false, reason: "disabled" });

  const now = Date.now();
  const exp = Date.parse(String(claims.expires_at ?? ""));
  const status = Number.isNaN(exp) ? "expired" : now <= exp ? "valid" : now <= exp + 3 * 86400_000 ? "grace" : "expired";
  return Response.json({
    valid: status !== "expired",
    status,
    license_id: claims.license_id,
    gym_id: lic.gym_id,
    tier: lic.tier,
  });
});
