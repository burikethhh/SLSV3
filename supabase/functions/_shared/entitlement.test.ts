import { entitlementState, makeClaims, signEntitlement } from "./entitlement.ts";
import { b64url, importPublicKey, PSS } from "./licenseCrypto.ts";
const assert = (value: boolean, message: string) => { if (!value) throw new Error(message); };

Deno.test("expiry, grace and revoke have independent precedence over review", () => {
  const prior = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    const license = { revoked: false, expires_at: new Date(Date.now()).toISOString() };
    assert(entitlementState(license) === "valid", "exact expiry remains valid");
    license.expires_at = new Date(Date.now() - 3 * 86400_000).toISOString();
    assert(entitlementState(license) === "grace", "exact grace deadline");
    license.expires_at = new Date(Date.now() - 3 * 86400_000 - 1).toISOString();
    assert(entitlementState(license) === "expired", "day four is blocked");
    license.revoked = true;
    assert(entitlementState(license) === "revoked", "revoked stays revoked");
    assert(entitlementState(license, true) === "suspended", "facility suspension wins");
    assert(entitlementState(null) === "no_subscription", "no license is not active");
    assert(entitlementState({ revoked: false, expires_at: "invalid" }) === "invalid", "invalid dates fail closed");
  } finally { Date.now = prior; }
});

Deno.test("device claims remain RSA-PSS signed with preserved license identity", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pem = (name: string, buffer: ArrayBuffer) => `-----BEGIN ${name}-----\n${btoa(String.fromCharCode(...new Uint8Array(buffer)))}\n-----END ${name}-----`;
  const previous = Deno.env.get("RSA_PRIVATE_KEY_PEM");
  Deno.env.set("RSA_PRIVATE_KEY_PEM", pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  try {
    const expires = new Date(Date.now() + 14 * 86400_000);
    const claims = { ...makeClaims({ id: "gym-fixture", name: "Fixture", owner_email: "owner@example.invalid" }, "trial-fixture", "pro", expires), hwid: "device-fixture", device_id: "terminal-fixture", account_id: "account-fixture" };
    const token = await signEntitlement(claims);
    const [payload, signature] = token.slice(5).split(".");
    const key = await importPublicKey(pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)));
    assert(await crypto.subtle.verify(PSS, key, b64url.decode(signature).buffer as ArrayBuffer, b64url.decode(payload).buffer as ArrayBuffer), "device token signature verifies");
    const decoded = JSON.parse(new TextDecoder().decode(b64url.decode(payload)));
    assert(decoded.hwid === "device-fixture" && decoded.license_id === "trial-fixture", "device binding preserves subscription id");
    assert(decoded.max_members === 500, "tier cap preserved");
  } finally {
    if (previous === undefined) Deno.env.delete("RSA_PRIVATE_KEY_PEM"); else Deno.env.set("RSA_PRIVATE_KEY_PEM", previous);
  }
});
