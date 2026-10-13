// Current account authorization + explicit facility + registered device.
// Listing facilities never exposes tokens. Only owners may connect terminals.
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { entitlementState, makeClaims, signEntitlement, UUID_RE } from "../_shared/entitlement.ts";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";
import { b64url } from "../_shared/licenseCrypto.ts";

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user) return new Response("Please sign in again", { status: 401 });
  if (!user.email_confirmed_at || user.app_metadata?.role !== "owner") return new Response("A verified owner account is required to connect GymPOS", { status: 403 });
  if (user.factors?.some((factor) => factor.status === "verified")) {
    let aal = "";
    try { aal = JSON.parse(new TextDecoder().decode(b64url.decode(jwt.split(".")[1]))).aal; } catch { /* reject malformed claims */ }
    if (aal !== "aal2") return new Response("Complete two-factor verification to connect GymPOS", { status: 403 });
  }
  const rl = check(`license-fetch:${user.id}`, 120, 60);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);
  const ids: string[] = Array.isArray(user.app_metadata.gym_ids)
    ? user.app_metadata.gym_ids.filter((id: unknown) => typeof id === "string" && UUID_RE.test(id)) : [];
  const { data: gyms, error } = await supa.from("gyms").select("id,name,status,disabled,owner_email,tier")
    .in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]).order("name");
  if (error) return new Response("Facility lookup unavailable", { status: 503 });
  let body;
  try { body = await req.json(); } catch { return new Response("Invalid request", { status: 400 }); }
  if (!body.gym_id) return Response.json({ gyms: gyms ?? [], licenses: [] });
  const gym = (gyms ?? []).find((g) => g.id === body.gym_id);
  if (!gym) return new Response("This facility is not assigned to your account", { status: 403 });
  const hwid = String(body.hwid ?? "");
  const name = String(body.device_name ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(hwid) || !name || name.length > 100) return new Response("Terminal identity and name required", { status: 400 });
  const { data: license, error: licenseError } = await supa.from("licenses")
    .select("id,tier,revoked,expires_at,is_trial,created_at").eq("gym_id", gym.id)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (licenseError) return new Response("Subscription lookup unavailable", { status: 503 });
  const state = entitlementState(license, gym.disabled || gym.status === "rejected");
  if (state !== "valid" && state !== "grace") return Response.json({ gym, state, license, licenses: [] });
  const { data: prior, error: deviceError } = await supa.from("terminals").select("id,active")
    .eq("gym_id", gym.id).eq("hwid", hwid).maybeSingle();
  if (deviceError) return new Response("Terminal lookup unavailable", { status: 503 });
  if (prior && !prior.active) return Response.json({ gym, state: "device_revoked", licenses: [] });
  if (!prior) {
    const { error: insertError } = await supa.from("terminals").upsert({ gym_id: gym.id, hwid, name, registered_by: user.id }, { onConflict: "gym_id,hwid", ignoreDuplicates: true });
    if (insertError) return new Response("Could not register terminal", { status: 503 });
  }
  const { data: device, error: updateError } = await supa.from("terminals")
    .update({ name, last_seen_at: new Date().toISOString() }).eq("gym_id", gym.id).eq("hwid", hwid).eq("active", true).select("id,name").maybeSingle();
  if (updateError) return new Response("Terminal registration unavailable", { status: 503 });
  if (!device) return Response.json({ gym, state: "device_revoked", licenses: [] });
  try {
    const rawToken = await signEntitlement({ ...makeClaims(gym, license!.id, license!.tier, new Date(license!.expires_at)), hwid, device_id: device.id, account_id: user.id });
    return Response.json({ gym, device, state, license, server_time: Date.now(), licenses: [{ ...license, gym_id: gym.id, raw_token: rawToken }] });
  } catch { return new Response("Terminal activation unavailable", { status: 503 }); }
});
