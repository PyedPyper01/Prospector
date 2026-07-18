// Postcode Prospector — FCA Financial Services Register verification.
// Classifies financial-services leads by PERMISSIONS, not by name:
//   IFA  = advising on investments (+ pensions)  -> keep
//   RESTRICTED = tied/network (SJP, NFU Mutual)  -> flag
//   MORTGAGE ONLY / INSURANCE ONLY               -> flag (these are the contaminants)
//   NOT ON REGISTER                              -> flag (unauthorised for advice)
// Env vars: FCA_API_KEY, FCA_EMAIL. Falls back to keys passed in body.
const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
const BASE = "https://register.fca.org.uk/services/V0.1";

function norm(s){ return (s||"").toLowerCase().replace(/\b(ltd|limited|llp|plc|the|and|&|co)\b/g,"").replace(/[^a-z0-9]/g,""); }

async function fcaGet(path, key, email){
  const r = await fetch(BASE + path, { headers: { "X-Auth-Email": email, "X-Auth-Key": key, "Content-Type": "application/json" } });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const key = clean(process.env.FCA_API_KEY || body.fcaKey);
    const email = clean(process.env.FCA_EMAIL || body.fcaEmail) || "";  // set FCA_EMAIL env var (already on Netlify) or paste in Settings
    if (!key) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: "no FCA key" }) };
    const name = (body.name || "").trim();
    if (!name) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true }) };

    // 1. search the register by firm name
    const search = await fcaGet(`/Search?q=${encodeURIComponent(name)}&type=firm`, key, email);
    const hits = (search && search.Data) ? search.Data : [];
    if (!hits.length) return { statusCode: 200, headers, body: JSON.stringify({ found: false, verdict: "NOT ON REGISTER" }) };

    // 2. best match by normalised name
    const target = norm(name);
    let best = hits[0], bestScore = 0;
    for (const h of hits) {
      const n = norm(h["Name"] || "");
      let s = 0;
      if (n === target) s = 1;
      else if (n.includes(target) || target.includes(n)) s = 0.8;
      if (s > bestScore) { bestScore = s; best = h; }
    }
    if (bestScore === 0) return { statusCode: 200, headers, body: JSON.stringify({ found: false, verdict: "NOT ON REGISTER" }) };

    const frn = best["Reference Number"] || "";
    const status = best["Status"] || "";
    const out = { found: true, frn, firmName: best["Name"], status };

    // 3. pull permissions — try both documented shapes; record whether we actually got any
    let permsData = null;
    for (const path of [`/Firm/${frn}/Permissions`, `/Firm/${frn}/Requirements`, `/Firm/${frn}`]) {
      const p = await fcaGet(path, key, email);
      if (p && p.Data && (Array.isArray(p.Data) ? p.Data.length : Object.keys(p.Data).length)) { permsData = p.Data; break; }
    }
    out.permissionsRead = !!permsData;
    const permText = JSON.stringify(permsData || []).toLowerCase();
    out.hasInvestmentAdvice = /advising on investments|advising on p2p|managing investments|personal recommendation/.test(permText);
    out.hasPensionTransfer = /pension transfer|pension opt|advising on pension/.test(permText);
    out.hasHomeFinance = /home finance|mortgage|regulated mortgage contract/.test(permText);
    out.hasInsurance = /insurance distribution|insurance mediation|non-investment insurance/.test(permText);

    // 4. restricted / network detection
    const nm = (best["Name"] || "").toLowerCase();
    const NETWORKS = ["st. james's place","st james's place","st jamess place","nfu mutual","openwork","quilter","intrinsic","true potential","sesame","tenet","amber river","the openwork partnership"];
    out.isNetwork = NETWORKS.some(n => nm.includes(n.replace(/[^a-z ]/g,"")) || nm.includes(n));

    // 5. verdict
    out.registerUrl = `https://register.fca.org.uk/s/firm?id=${frn}`;
    if (/appointed representative/i.test(status)) out.verdict = "APPOINTED REPRESENTATIVE (tied — not independent)";
    else if (!/authorised|registered/i.test(status)) out.verdict = "NOT AUTHORISED (" + status + ")";
    else if (out.isNetwork) out.verdict = "RESTRICTED / NETWORK";
    else if (out.hasInvestmentAdvice) out.verdict = out.hasPensionTransfer ? "IFA (investment + pension advice)" : "IFA (investment advice)";
    else if (!out.permissionsRead) out.verdict = "AUTHORISED — permissions unreadable, verify manually";  // NEVER claim a negative we did not prove
    else if (out.hasHomeFinance) out.verdict = "MORTGAGE ONLY";
    else if (out.hasInsurance) out.verdict = "INSURANCE ONLY";
    else out.verdict = "AUTHORISED — no investment permission found";
    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
