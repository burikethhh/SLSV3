// Auth + RBAC guards. Supabase Auth (replaces v2 HMAC ceo:/owner: strings).
// TTL policy: CEO 12h, owner 30d — enforce via Supabase JWT expiry + re-login.
import { db } from "./supabase";

export type Role = "ceo" | "owner" | "manager";

export async function session() {
  const { data } = await db().auth.getSession();
  return data.session;
}

export function roleOf(s: unknown): Role | null {
  const r = (s as { user?: { app_metadata?: { role?: Role } } })?.user?.app_metadata?.role;
  return r === "ceo" || r === "owner" || r === "manager" ? r : null;
}

export async function signIn(email: string, password: string) {
  const { error } = await db().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUpOwner(email: string, password: string) {
  // Confirm link must land back on this app, not the Supabase Site URL.
  const { error } = await db().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${window.location.origin}/#/login` },
  });
  if (error) throw error;
}

export async function signOut() {
  await db().auth.signOut();
  location.hash = "#/login";
}

export function requireRole(s: unknown, roles: Role[]): boolean {
  const r = roleOf(s);
  return !!r && roles.includes(r);
}
