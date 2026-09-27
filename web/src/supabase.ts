// Supabase client — anon key only. Service_role stays in Edge Functions.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !anon) throw new Error("Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (.env)");
    client = createClient(url, anon);
  }
  return client;
}

// First gym scoping helper: owner JWT app_metadata.gym_ids; CEO = all.
export function myGymIds(session: unknown): string[] | null {
  const meta = (session as { user?: { app_metadata?: { gym_ids?: string[]; role?: string } } })
    ?.user?.app_metadata;
  if (meta?.role === "ceo") return null; // null = unscoped
  return meta?.gym_ids ?? [];
}
