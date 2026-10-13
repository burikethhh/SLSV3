import { b64url, importPrivateKey, PSS } from "./licenseCrypto.ts";

export const TIERS: Record<string, { max: number; usd: number }> = {
  basic: { max: 200, usd: 99 }, pro: { max: 500, usd: 199 }, ultra: { max: 1000, usd: 349 },
};
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function entitlementState(license: { revoked: boolean; expires_at: string } | null, disabled = false): string {
  if (disabled) return "suspended";
  if (!license) return "no_subscription";
  if (license.revoked) return "revoked";
  const expiry = Date.parse(license.expires_at);
  if (!Number.isFinite(expiry)) return "invalid";
  if (Date.now() <= expiry) return "valid";
  return Date.now() <= expiry + 3 * 86400_000 ? "grace" : "expired";
}
export async function signEntitlement(claims: Record<string, unknown>): Promise<string> {
  const pem = Deno.env.get("RSA_PRIVATE_KEY_PEM");
  if (!pem) throw new Error("server signing key not configured");
  const msg = new TextEncoder().encode(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign(PSS, await importPrivateKey(pem), msg.buffer as ArrayBuffer));
  return `GPOS-${b64url.encode(msg)}.${b64url.encode(sig)}`;
}
export function makeClaims(gym: { id: string; name: string; owner_email: string }, id: string, tier: string, expires: Date) {
  return {
    license_id: id, gym_id: gym.id, gym_name: gym.name, owner_email: gym.owner_email,
    tier, issued_at: new Date().toISOString(), expires_at: expires.toISOString(),
    max_members: TIERS[tier].max, hardware_lock_enabled: true, hwid: "", ip_hint: "",
    exp_unix: Math.floor(expires.getTime() / 1000), grace_until: Math.floor(expires.getTime() / 1000) + 3 * 86400,
  };
}
