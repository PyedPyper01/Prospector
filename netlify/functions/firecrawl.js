// Postcode Prospector — Firecrawl deep email lookup (metered fallback).
// The basic in-process crawl (enrich.js) fetches raw HTML for ~8 pages but MISSES emails on sites that
// render the address in JavaScript, hide it behind a cookie wall, or only show it on a contact page the
// homepage doesn't plainly link. Firecrawl renders JS and returns clean page content, so it recovers
// those. Called ONCE per distinct domain (cached by the frontend), only AFTER the free steps (site
// crawl + propagating a sibling's email) have failed — and BEFORE Hunter. Metered: 1,000 credits/cycle,
// so at most 2 page-scrapes per domain (homepage → one contact/about page).
// Uses the FIRECRAWL_API_KEY env var (or a key passed in the body, e.g. pasted in ⚙ Settings).

const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
const FC = "https://api.firecrawl.dev/v1/scrape";

// Junk local-parts / hosts that are never a firm's real contact address.
const BAD_EMAIL = /@(?:example|sentry|wixpress|domain|email|yourcompany|company|test|sentry-next)\.|@[\w.-]*\.(?:png|jpg|jpeg|gif|svg|webp|css|js)$|^[a-f0-9]{16,}@|@2x|\.(png|jpg|jpeg|gif|svg|webp)$/i;
// Web hosts / site builders / agencies whose support address gets scraped from a footer "site by…" credit
// — never the firm's own contact address. Dropped unless the firm has NO same-domain address either.
const HOST_PROVIDER = /^(?:34sp|wix|squarespace|godaddy|hostinger|123-?reg|fasthosts|ionos|1and1|names|tsohost|krystal|heartinternet|siteground|bluehost|weebly|wordpress|automattic|cloudflare|mailchimp|sentry|shopify|createandhost|itseeze|mediaworks|thewebdesigners?|itsdesign)\./i;
const eDom = e => (e.split("@")[1] || "").toLowerCase();

function extractEmails(text) {
  const out = new Set();
  if (!text) return out;
  let s = String(text);
  // de-obfuscate common forms: "name [at] domain [dot] co [dot] uk", "name(at)domain.co.uk"
  s = s.replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, "@").replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".");
  // plain addresses + mailto:
  const re = /(?:mailto:)?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})/gi;
  let m;
  while ((m = re.exec(s))) {
    const e = m[1].toLowerCase().replace(/[.,;:)\]]+$/, "");
    if (!BAD_EMAIL.test(e) && e.length < 80) out.add(e);
  }
  return out;
}

async function scrape(url, key) {
  try {
    const r = await fetch(FC, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        url,
        formats: ["markdown", "links"],
        onlyMainContent: false,   // we WANT the footer (emails usually live there)
        timeout: 20000,
        waitFor: 1200
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.success === false) return { emails: new Set(), links: [], err: (d.error || `http ${r.status}`) };
    const data = d.data || {};
    const emails = extractEmails(data.markdown || "");
    // some emails only appear as mailto: hrefs in the link list
    (data.links || []).forEach(L => { const s = typeof L === "string" ? L : (L && L.href) || ""; if (/^mailto:/i.test(s)) extractEmails(s).forEach(e => emails.add(e)); });
    return { emails, links: (data.links || []).map(L => (typeof L === "string" ? L : (L && L.href) || "")).filter(Boolean), err: null };
  } catch (e) { return { emails: new Set(), links: [], err: e.message }; }
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const key = clean(process.env.FIRECRAWL_API_KEY || body.firecrawlKey);
    if (!key) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: "no Firecrawl key (set FIRECRAWL_API_KEY env var, or paste it in Settings)" }) };

    let domain = String(body.domain || body.website || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
    if (!domain || !/\./.test(domain)) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: "no domain" }) };
    const origin = `https://${domain}`;

    // 1) homepage (with footer) — usually enough
    let credits = 0;
    const home = await scrape(origin, key); credits++;
    let emails = new Set(home.emails);
    const pages = [origin];

    // 2) if still nothing, scrape ONE contact/about page — prefer a same-host link the homepage exposes,
    //    else fall back to the usual guesses. Max 2 scrapes/domain to respect the credit budget.
    if (!emails.size) {
      const same = (home.links || []).filter(h => { try { return new URL(h, origin).hostname.replace(/^www\./, "") === domain; } catch { return false; } });
      const contactish = same.find(h => /contact|about|get-in-touch|find-us|team|enquir/i.test(h));
      const target = contactish || `${origin}/contact`;
      const c = await scrape(target, key); credits++;
      c.emails.forEach(e => emails.add(e));
      pages.push(target);
    }

    // Prefer the firm's OWN-domain address (info@theirdomain). A footer often also exposes the web host's
    // support@ (e.g. support@34sp.com) or an SEO agency's mailbox — keep those only if there's no
    // same-domain address at all, and even then drop known host/builder providers.
    let all = [...emails];
    const same = all.filter(e => { const d = eDom(e); return d === domain || d.endsWith("." + domain) || domain.endsWith("." + d); });
    const list = (same.length ? same : all.filter(e => !HOST_PROVIDER.test(eDom(e)))).slice(0, 6);
    return { statusCode: 200, headers, body: JSON.stringify({ domain, emails: list, count: list.length, pagesScraped: pages.length, credits, error: home.err || null }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, error: e.message }) };
  }
};
