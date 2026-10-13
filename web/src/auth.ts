// Auth + RBAC guards. Supabase Auth (replaces v2 HMAC ceo:/owner: strings).
// Session expiry follows Supabase settings; no role-specific TTL is imposed here.
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

export type GymDraft = { gym_name: string; location: string; tier: string };

export async function signUpOwner(email: string, password: string, draft: GymDraft) {
  // Confirm link must land back on this app, not the Supabase Site URL.
  const { data, error } = await db().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${window.location.origin}/#/setup`, data: { onboarding: draft } },
  });
  if (error) throw error;
  return data;
}

export async function completeOwnerSetup(draft: GymDraft) {
  const s = await session();
  if (!s) throw new Error("Sign in after verifying your email.");
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/owner-apply`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
    body: JSON.stringify(draft),
  });
  if (!res.ok) throw new Error(await res.text());
  const { error } = await db().auth.refreshSession();
  if (error) throw error;
}

export async function resendVerification(email: string) {
  const { error } = await db().auth.resend({ type: "signup", email, options: { emailRedirectTo: `${window.location.origin}/#/setup` } });
  if (error) throw error;
}

export async function sendPasswordReset(email: string) {
  const { error } = await db().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/#/reset-password` });
  if (error) throw error;
}

export async function signOut() {
  await db().auth.signOut({ scope: "local" });
  location.hash = "#/login";
}

export function requireRole(s: unknown, roles: Role[]): boolean {
  const r = roleOf(s);
  return !!r && roles.includes(r);
}
