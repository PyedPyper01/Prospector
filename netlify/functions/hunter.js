// Postcode Prospector — Hunter.io domain email lookup (metered fallback).
// Finds a firm's emails BY DOMAIN — exactly what's needed when the site crawl fails (JS-only sites,
// contact-form-only sites). The frontend calls this ONCE per distinct domain (cached), only after the
// free methods (site crawl + propagating a known email from a sibling row) have failed, and only for
// domains that still have no email — never once per row (branches of a firm share a domain).
// Uses the HUNTER_KEY env var (or a key passed in the body).
const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const key = clean(process.env.HUNTER_KEY || body.hunterKey);
    if (!key) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: "no Hunter key (set HUNTER_KEY env var, or paste it in Settings)" }) };
    const domain = String(body.domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
    if (!domain || !/\./.test(domain)) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: "no domain" }) };

    // FREE PRE-CHECK. email-count reports how many addresses Hunter holds for a domain and does NOT consume
    // a credit. Roughly half of small-business domains have nothing indexed, so asking first means a credit
    // is only spent where there is something to buy — on a 2,000/month allowance that is the difference
    // between ~940 emails and ~1,900 from the same budget.
    if (body.skipEmpty !== false) {
      try {
        const c = await fetch(`https://api.hunter.io/v2/email-count?domain=${encodeURIComponent(domain)}&api_key=${key}`);
        const cd = await c.json().catch(() => ({}));
        const total = cd && cd.data ? (cd.data.total || 0) : null;
        if (total === 0) {
          return { statusCode: 200, headers, body: JSON.stringify({ domain, emails: [], count: 0, creditUsed: false, note: "Hunter holds no addresses for this domain — no credit spent" }) };
        }
      } catch (e) { /* if the free check fails, fall through and do the paid lookup */ }
    }

    const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${key}&limit=5`);
    const d = await r.json().catch(() => ({}));
    if (d && d.errors) return { statusCode: 200, headers, body: JSON.stringify({ domain, emails: [], error: (d.errors[0] && d.errors[0].details) || "hunter error" }) };
    const emails = ((d.data && d.data.emails) || []).map(e => String(e.value || "").toLowerCase()).filter(e => /@/.test(e));
    return { statusCode: 200, headers, body: JSON.stringify({ domain, emails, count: emails.length, creditUsed: true }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, error: e.message }) };
  }
};
