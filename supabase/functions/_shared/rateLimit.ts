// Fixed-window limiter for Supabase Edge Functions.
// Live limits (per-IP; x-forwarded-for is platform-set, not spoofable):
//   sync 300/min · updates-check 60/h · license-verify 60/h · license-issue 30/h
//   license-revoke 30/h · gym-admin 60/h · user-admin 30/h · staff-create 60/h
//   bootstrap-ceo 5/h
// Deno-safe: in-memory Map (per-isolate). For multi-instance strictness,
// back with a Supabase `rate_counters` table — this covers single-region use.

const buckets = new Map<string, number[]>();

export function check(key: string, maxAttempts: number, windowSecs: number): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const win = windowSecs * 1000;
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < win);
  if (arr.length >= maxAttempts) {
    const retryAfter = Math.max(1, Math.ceil((win - (now - arr[0])) / 1000));
    buckets.set(key, arr);
    return { ok: false, retryAfter };
  }
  arr.push(now);
  buckets.set(key, arr);
  return { ok: true };
}

export function reset(key: string) {
  buckets.delete(key);
}

export function rateLimitedResponse(retryAfter: number): Response {
  return new Response(
    JSON.stringify({ code: "RATE_LIMITED", retry_after_seconds: retryAfter }),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter) } },
  );
}
