// Return the caller's newest usable license token.
// raw_token is intentionally hidden from PostgREST; terminals must use this
// authenticated, service-role-backed function instead.
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user || user.app_metadata?.role !== "owner") return new Response("unauthorized", { status: 401 });

  const gymIds = Array.isArray(user.app_metadata?.gym_ids)
    ? user.app_metadata.gym_ids.filter((id: unknown): id is string => typeof id === "string" && UUID_RE.test(id))
    : [];
  if (!gymIds.length) return Response.json({ licenses: [] });
  const { data: gyms, error: gymError } = await supa.from("gyms")
    .select("id").in("id", gymIds).eq("disabled", false).neq("status", "rejected");
  if (gymError) return new Response("gym lookup failed", { status: 500 });
  const enabledIds = (gyms ?? []).map((gym) => gym.id);
  if (!enabledIds.length) return Response.json({ licenses: [] });
  const { data, error } = await supa
    .from("licenses")
    .select("id,gym_id,revoked,expires_at,tier,price_usd,is_trial,raw_token,created_at")
    .eq("revoked", false)
    .in("gym_id", enabledIds)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return new Response("license lookup failed", { status: 500 });
  const license = (data ?? []).find((row) => row.raw_token && Date.parse(row.expires_at) + 3 * 86400_000 >= Date.now());
  if (!license) return Response.json({ licenses: [] });

  return Response.json({ licenses: [license] });
});
