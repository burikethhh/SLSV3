import { needsMfa } from "./assurance.ts";
import { b64url } from "./licenseCrypto.ts";
Deno.test("verified MFA requires AAL2, malformed claims fail closed", () => {
  const token=(aal:string)=>`header.${b64url.encode(new TextEncoder().encode(JSON.stringify({aal})))}.signature`;
  const user={factors:[{status:"verified"}]};
  if (!needsMfa(user,token("aal1")) || needsMfa(user,token("aal2")) || !needsMfa(user,"malformed") || needsMfa({},token("aal1"))) throw Error("MFA contract violated");
});
