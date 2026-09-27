// CORS helper for browser-called Edge Functions (dashboard on vercel.app).
// OPTIONS preflight → 204; every response gets Access-Control-Allow-Origin: *.
// Desktop callers (sync/updates-check) ignore CORS headers — harmless there.
import { serve as stdServe } from "https://deno.land/std@0.224.0/http/server.ts";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export type Handler = (req: Request) => Response | Promise<Response>;

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.status === 204 ? "No Content" : res.statusText, headers });
}

/** Drop-in replacement for std `serve` that handles CORS. */
export function serve(handler: Handler): void {
  stdServe(async (req) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    try {
      return withCors(await handler(req));
    } catch {
      // Never leak internals (stack traces / driver messages) to callers.
      return withCors(new Response("internal error", { status: 500 }));
    }
  });
}
