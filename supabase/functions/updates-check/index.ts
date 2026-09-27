// Updates manifest — consumed by the desktop `update_check` Tauri command
// (Settings → "Check for updates"), NOT by tauri-plugin-updater (no updater
// plugin/signing pipeline yet; when CI signs releases, paste the .sig into the
// Releases dashboard row and this response is already Tauri-shaped).
// GET ?current=<semver>&channel=stable → public endpoint (verify_jwt=false —
// desktop has no Supabase session), rate-limited 60/hour per IP.
//
// App shape: { current, update, version?, pub_date?, url?, notes?, signature? }
// Rollout gate: deterministic per client — hash(current) % 100 < rollout_pct
// so a staged rollout doesn't flip-flop for the same terminal.
import { serve } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { check, rateLimitedResponse } from "../_shared/rateLimit.ts";

serve(async (req) => {
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",").pop()!.trim();
  const rl = check(`updates-check:${ip}`, 60, 3600);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const url = new URL(req.url);
  const channel = url.searchParams.get("channel") ?? "stable";
  const current = url.searchParams.get("current") ?? "0.0.0";
  if (!/^[0-9A-Za-z.+-]{1,32}$/.test(current)) return new Response("bad current", { status: 400 });

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await supa
    .from("releases")
    .select("version,channel,rollout_pct,download_url,notes,sig,created_at")
    .eq("channel", channel)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("releases query", error.message);
    return new Response("releases unavailable", { status: 500 }); // fail-closed: no silent "no update"
  }

  if (!data) return Response.json({ current, update: false });

  const newer = compareSemver(data.version, current) > 0;
  const bucket = hashStr(current) % 100;
  const inRollout = bucket < data.rollout_pct;

  if (!newer || !inRollout) return Response.json({ current, update: false, version: data.version });

  return Response.json({
    current,
    update: true,
    version: data.version,
    pub_date: data.created_at,
    url: data.download_url,
    notes: data.notes,
    signature: data.sig || "", // minisign .sig pasted on the Releases dashboard row
  });
});

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
