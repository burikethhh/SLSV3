// Public license-verify helper (replaces v2 POST /licenses/verify click-through).
// Calls the license-verify Edge Function; never exposes the private key.
// verify_jwt=true → anonymous API key in Authorization is required.
export async function renderVerify(root: HTMLElement) {
  root.innerHTML = `<h2>Verify license key</h2><div class="row">
    <input id="tok" placeholder="GPOS-..." style="min-width:min(560px,90vw)" />
    <button class="primary" id="go">Verify</button></div><pre id="out" class="muted"></pre>`;
  (document.getElementById("go") as HTMLButtonElement).onclick = async () => {
    const token = (document.getElementById("tok") as HTMLInputElement).value.trim();
    const base = import.meta.env.VITE_SUPABASE_URL;
    const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
    const res = await fetch(`${base}/functions/v1/license-verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}` },
      body: JSON.stringify({ token }),
    });
    document.getElementById("out")!.textContent = await res.text();
  };
}
