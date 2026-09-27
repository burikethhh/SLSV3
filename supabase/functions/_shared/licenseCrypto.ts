// Shared crypto helpers for license Edge Functions (Deno/WebCrypto).
// INTEROP CONTRACT (verified 2026-09): Rust `rsa` crate PSS defaults salt_len
// to digest output size (32 for SHA-256), and `VerifyingKey::new` pins the same.
// So: sign with saltLength 32 here, verify with saltLength 32 there — and always
// run the roundtrip test (sign here → verify in `desktop/.../license_verify.rs`)
// after ANY key rotation or runtime upgrade.

const B64 = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  },
  decode(s: string): Uint8Array {
    const p = s.replaceAll("-", "+").replaceAll("_", "/");
    const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

function pemToDer(pem: string, label: string): Uint8Array {
  // Secrets may be single-line with literal \n escapes (env-file set) — normalize first.
  const normalized = pem.replace(/\\r/g, "").replace(/\\n/g, "\n").trim();
  const body = normalized.replace(`-----BEGIN ${label}-----`, "").replace(`-----END ${label}-----`, "").replace(/\s+/g, "");
  if (!body) throw new Error(`empty PEM body for ${label}`);
  return B64.decode(body);
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem, "PRIVATE KEY").buffer as ArrayBuffer,
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function importPublicKey(pem: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "spki",
    pemToDer(pem, "PUBLIC KEY").buffer as ArrayBuffer,
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export const PSS = { name: "RSA-PSS", saltLength: 32 } as const;
export const b64url = B64;
