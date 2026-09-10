// Postcode Prospector — PUBLISH TO THE AFTERLIFE SALES CRM.
// Mirrors publish.js: the bearer token lives ONLY in this site's environment
// (CRM_IMPORT_TOKEN — set the SAME value on the generator site) and is sent
// server-to-server; it is never exposed to the browser and never hardcoded.
// Unlike the AfterLife marketplace publish, contact phone and email ARE sent —
// this is the sales pipeline, not the public directory.
//
// Body: { mode: "selected" | "master", rows: [...] }  (the page chunks to ≤200)

const CRM_INTAKE_URL = "https://afterlifeemailgenerator.netlify.app/.netlify/functions/crm-intake";

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const token = (process.env.CRM_IMPORT_TOKEN || "").trim();
    if (!token) {
      return { statusCode: 200, headers, body: JSON.stringify({
        ok: false, error: "CRM_IMPORT_TOKEN is not set on this Netlify site. Add it in Site settings → Environment variables (same value as on the generator site), then redeploy." }) };
    }
    const body = JSON.parse(event.body || "{}");
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 200) : [];
    if (!rows.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: "No rows to publish." }) };
    const mode = body.mode === "master" ? "master" : "selected";

    const r = await fetch(CRM_INTAKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      // `force` has to be FORWARDED, not merely accepted. This function rebuilds the body from scratch, so
      // anything the page sends is dropped unless it is named right here — which is why ticking Override
      // changed nothing: the browser sent the flag, this line discarded it, and the CRM went on skipping
      // every record it already held.
      body: JSON.stringify({ mode, rows, force: body.force === true }),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = { ok: false, error: "CRM replied " + r.status }; }
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: String(e.message || e) }) };
  }
};
