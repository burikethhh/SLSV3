import { b64url } from "./licenseCrypto.ts";

// Call only after auth.getUser has validated this exact JWT. This is not a
// signature verifier; fresh server factors determine whether MFA is required.
export function needsMfa(user: { factors?: { status: string }[] }, jwt: string): boolean {
  if (!user.factors?.some(factor => factor.status === "verified")) return false;
  try {
    return JSON.parse(new TextDecoder().decode(b64url.decode(jwt.split(".")[1]))).aal !== "aal2";
  } catch { return true; }
}
