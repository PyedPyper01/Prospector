// Diagnostic for the supplier store. Answers ONE question: when kb.js fails, is it the config, the network,
// or Supabase itself? Reports the host and the raw error — never the key.
//
// This used to be a one-off probe for Netlify Blobs and required '@netlify/blobs', which is not bundled into
// these zips, so it only ever threw "Cannot find module" and told us nothing. Dependency-free now, like every
// other function here.
const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;

exports.handler = async () => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const base = clean(process.env.SUPABASE_URL);
  const key = clean(process.env.SUPABASE_KEY);
  const out = { haveUrl: !!base, haveKey: !!key, keyLength: key ? key.length : 0 };

  // The hostname is not a secret — it is in every request the app already makes. The key is, so it never leaves.
  if (base) { try { out.host = new URL(base).host; } catch { out.host = "SUPABASE_URL is not a valid URL"; } }
  if (!base || !key) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: "env-missing", ...out }) };

  // Hit the PostgREST root rather than a table: it answers even when the schema is wrong, so a failure HERE
  // means the project is unreachable (paused / deleted / DNS), not that the query was bad.
  const t0 = Date.now();
  try {
    const r = await fetch(base.replace(/\/$/, "") + "/rest/v1/", { headers: { apikey: key, Authorization: "Bearer " + key } });
    out.ms = Date.now() - t0;
    out.httpStatus = r.status;
    out.ok = r.ok;
    if (!r.ok) {
      out.reason = (r.status === 401 || r.status === 403) ? "key-rejected" : "http-error";
      out.detail = (await r.text()).slice(0, 300);
    } else {
      out.reason = "reachable";
      // Only now try the real table, so "project up, table missing" is distinguishable from "project down".
      const t = await fetch(base.replace(/\/$/, "") + "/rest/v1/suppliers?select=id&limit=1",
        { headers: { apikey: key, Authorization: "Bearer " + key, Prefer: "count=exact" } });
      out.suppliersStatus = t.status;
      out.rowsInTable = (t.headers.get("content-range") || "").split("/")[1] || null;
      if (!t.ok) out.suppliersDetail = (await t.text()).slice(0, 300);
    }
  } catch (e) {
    out.ms = Date.now() - t0;
    out.ok = false;
    // Node's fetch collapses DNS failure, refused connection and TLS error into a bare "fetch failed";
    // the cause chain is where the real reason lives.
    out.reason = "unreachable";
    out.error = e.message;
    out.cause = e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : null;
    out.likely = "A Supabase free-tier project is PAUSED after ~7 days idle and its hostname stops resolving. "
      + "Check the Supabase dashboard for this project and press Restore if it is paused.";
  }
  return { statusCode: 200, headers, body: JSON.stringify(out) };
};
