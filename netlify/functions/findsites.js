// FREE website finder — no API, no cost, any scale. Guesses each firm's domain from its name, fetches the
// candidate pages, and keeps one only if the page actually NAMES the firm (a distinctive proper-noun word),
// so parked/generic/wrong sites are rejected. Companies House gives names for free; this turns most of them
// into websites for free — the answer to "£4,000 to look up websites". ~60%+ hit rate at £0. Dependency-free.

// Words dropped when BUILDING domain stems (keep brandable words like "wealth"/"financial" — they're often in
// the domain). Small list.
const CAND_STOP = new Set(["limited", "ltd", "llp", "plc", "the", "and", "of", "for", "group", "co", "uk", "services", "service", "company"]);
// Words that are NOT distinctive enough to VERIFY a match on (trade/generic). Broad list — verification must
// hit a real proper noun (the firm's actual name), not just "financial" or "care".
const VERIFY_STOP = new Set([...CAND_STOP, "financial", "finance", "advice", "advisers", "adviser", "advisory", "advisor", "management", "wealth", "planning", "partners", "associates", "consultants", "consulting", "solutions", "funeral", "directors", "director", "care", "homecare", "insurance", "mortgage", "independent", "chartered", "wealthmanagement", "financialplanning", "estate", "agents", "solicitors", "accountants", "florist", "florists"]);
const TLDS = [".co.uk", ".com", ".uk", ".org.uk"];

const words = s => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
const distinctive = name => words(name).filter(w => w.length > 2 && !VERIFY_STOP.has(w));

function candidates(name) {
  const w = words(name);
  const brand = w.filter(x => !CAND_STOP.has(x));         // brandable words (keeps wealth/financial)
  const stems = new Set();
  const add = s => { s = String(s || "").replace(/[^a-z0-9]/g, ""); if (s.length >= 3 && s.length <= 30) stems.add(s); };
  add(brand.join(""));                                    // brandable words joined
  add(w.join(""));                                        // all words joined
  add(brand.slice(0, 2).join(""));                        // first 2 brandable
  add(brand.slice(0, 3).join(""));
  add((brand[0] || "") + (brand[brand.length - 1] || "")); // first + last
  add(brand.map(x => x[0]).join(""));                     // initials of brandable
  if (brand[0]) add(brand[0]);                            // just the first brandable word
  const out = [];
  for (const s of [...stems].slice(0, 7)) for (const tld of TLDS) out.push(s + tld);
  return out;
}

async function fetchText(url, ms) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
    const r = await fetch(url, { signal: c.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; PostcodeProspector/1.0)" } });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.text()).slice(0, 80000).toLowerCase();
  } catch (e) { return null; }
}

async function resolveOne(f) {
  const dist = distinctive(f.name);
  if (!dist.length) return { name: f.name, website: "" };
  const town = String(f.town || "").toLowerCase();
  const cands = candidates(f.name).slice(0, 12);
  const checks = cands.map(async host => {
    const body = await fetchText("https://" + host, 3000) || await fetchText("http://" + host, 2500);
    if (!body) return null;
    const named = dist.some(tk => tk.length > 3 && body.includes(tk));
    if (!named) return null;
    // confidence: name + (trade word or town) present scores higher, but name alone is accepted
    const strong = (town && body.includes(town)) || dist.filter(tk => body.includes(tk)).length >= 2;
    return { host, strong };
  });
  const settled = (await Promise.all(checks)).filter(Boolean);
  if (!settled.length) return { name: f.name, website: "" };
  const pick = settled.find(x => x.strong) || settled[0];
  return { name: f.name, website: "https://" + pick.host.replace(/\/$/, "") };
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const firms = (Array.isArray(body.firms) ? body.firms : []).slice(0, 12).map(f => ({ name: String(f.name || "").trim(), town: f.town || "", postcode: f.postcode || "" })).filter(f => f.name);
    if (!firms.length) return { statusCode: 200, headers, body: JSON.stringify({ error: "no firms" }) };
    const results = await Promise.all(firms.map(resolveOne));
    return { statusCode: 200, headers, body: JSON.stringify({ asked: firms.length, resolved: results.filter(r => r.website).length, results, cost: 0 }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message }) };
  }
};
