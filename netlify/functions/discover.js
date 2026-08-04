// Unified AUTO-ROUTER discovery. ONE call — Prospector picks the right source for the trade itself, so the
// operator never chooses a "search model" per supplier type. Given {trade, area, locations[], n}:
//   • Register-able trades (map to a SIC code + are mostly limited companies) → Companies House (free,
//     comprehensive, real postcodes) via the chsearch function.
//   • Everything else (sole-trader / premise trades with no clean SIC) → Google Places.
// Then a FREE name pre-filter strips the obvious non-consumer noise Companies House returns under a shared
// SIC (holding / nominee / fund / SPV shells) and obvious national chains — leaving a clean candidate pool
// per area, ready for the existing enrich → vet → publish steps. Judgment on borderline independence stays
// with the AI vet; this only removes the clearly-irrelevant before any money is spent.

const SITE = "https://postcodeprospector.netlify.app/.netlify/functions";

// trade keyword → Companies House SIC code(s). If a trade matches here, Companies House is the source.
const SIC = {
  "financial advis": ["66220", "66190", "66300"], "ifa": ["66220", "66190", "66300"], "wealth": ["66300", "66220", "66190"],
  "mortgage": ["66190", "64921"], "pension": ["66300", "66220"], "insurance": ["66220", "66210", "66290"],
  "funeral": ["96030"], "florist": ["47760"], "solicitor": ["69101", "69102", "69109"], "legal": ["69101", "69102", "69109"],
  "accountant": ["69201", "69202", "69203"], "estate agent": ["68310"], "letting": ["68320", "68310"],
  "surveyor": ["71111", "68320"], "architect": ["71111"], "cater": ["56210", "56290"], "wedding": ["56210", "74901", "96090"],
  "care": ["87100", "87300", "88100", "88910"], "nursing": ["87100", "87300"], "domiciliary": ["88100", "87300"], "residential": ["87100", "87300"],
  "optician": ["47782"], "vet": ["75000"], "dentist": ["86230"], "physio": ["86900"], "photographer": ["74201"],
  "will": ["69102", "69109"], "probate": ["69102", "69109"],
  // NOTE: memorial/monumental masons, celebrants, musicians etc. are DELIBERATELY NOT here. Their SIC codes
  // are too broad (23700 = all stonework) and pull the wrong firms. They route to Google/web search instead,
  // which understands them as a TRADE and returns the real firms with their websites.
  "plumb": ["43220"], "electric": ["43210"], "builder": ["41200", "43999"], "landscap": ["81300"], "cleaning": ["81210", "81220"]
};
function sicFor(trade) { const t = String(trade || "").toLowerCase(); for (const k in SIC) { if (t.includes(k)) return SIC[k]; } return null; }

// FREE noise filter — Companies House shares SIC codes across consumer firms and their admin/fund shells.
const NOISE = /\b(holdings?|nominees?|trustees?|administrat(or|ion)|liquidity|custodian|deppositary|securitisation|special purpose|spv|bidco|topco|midco|newco|propco|holdco|\b(gp|lp) (limited|ltd)|(no|number) ?\d+ (gp|lp)\b|fund (i{1,3}|iv|v|management|services)|capital partners|private equity|ventures? (fund|capital)|sipp|ssas|self.?invested)\b/i;
const CHAIN = /\b(st\.? ?james|\bsjp\b|quilter|openwork|true potential|nfu mutual|dignity|co-?op|funeral partners|interflora|specsavers|foxtons|connells|hays travel)\b/i;

const pcOf = a => { const m = String(a || "").toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/); return m ? m[0] : ""; };
const distOf = a => { const m = pcOf(a).match(/^([A-Z]{1,2}\d[A-Z\d]?)/); return m ? m[1] : ""; };
const areaOf = a => { const m = pcOf(a).match(/^([A-Z]{1,2})/); return m ? m[1] : ""; };
const nkey = s => String(s || "").toLowerCase().replace(/&/g, "and").replace(/\b(ltd|limited|llp|plc|the|co)\b/g, "").replace(/[^a-z0-9]/g, "");

async function post(fn, body) { try { const r = await fetch(SITE + "/" + fn, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return await r.json(); } catch (e) { return { error: e.message }; } }

// Companies House path — comprehensive, free, real postcodes; website comes later in enrich.
async function viaCompaniesHouse(trade, area, locations, sics) {
  const j = await post("chsearch", { trade, area, locations, sic: sics.join(" ") });
  return { gross: j.grossMatches || (j.results || []).length, cands: (j.results || []).map(f => ({ name: f.name, area: f.area, district: f.district, postcode: f.postcode, address: f.address, companyNumber: f.number, sic: f.sic, website: "", phone: "", source: "companies-house" })) };
}

// OpenStreetMap path — FREE, and the fix for the "only 28 florists in CO" problem. Companies House by SIC
// only ever returns limited companies filed under one code, so it misses every sole trader, partnership and
// firm filed elsewhere. OSM maps actual PREMISES (shop=florist, shop=funeral_directors, craft=locksmith …)
// and carries websites and phones. Merged with Companies House rather than replacing it — the two overlap
// very little, so together they go far deeper than either alone. Costs nothing.
async function viaOSM(trade, area, locations) {
  // Districts are queried CONCURRENTLY. Each one costs a geocode plus an Overpass query (~10s), so doing
  // them one after another blew the function's 26s budget at only five districts and the whole sweep
  // returned an HTML timeout page. In parallel, eight districts cost about the same as one.
  // Overpass is a free shared service and throttles hard. Eight districts at once got us rate-limited and
  // it answered with empty result sets, which looked exactly like "no firms here". Three at a time is fast
  // enough to stay inside the function budget and gentle enough not to trip the limiter.
  const picks = locations.slice(0, 8);
  const settled = []; const POOL = 3; let next = 0;
  await Promise.all(Array.from({ length: Math.min(POOL, picks.length) }, async () => {
    while (true) {
      const i = next++; if (i >= picks.length) break;
      try { settled.push(await post("freesearch", { source: "osm", district: picks[i], request: trade })); }
      catch (e) { settled.push({ results: [] }); }
    }
  }));
  const cands = []; const seen = new Set(); let unavailable = 0;
  for (const j of settled) {
    if (j && j.unavailable) unavailable++;
    for (const r of (j.results || [])) {
      const nm = String(r.name || "").trim(); if (!nm) continue;
      const k = nm.toLowerCase().replace(/[^a-z0-9]/g, ""); if (seen.has(k)) continue; seen.add(k);
      const pc = r.postcode || pcOf(r.address);
      cands.push({ name: nm, area: pc ? areaOf(pc) : area, district: distOf(r.address) || (pc ? pc.split(" ")[0] : ""),
        postcode: pc, address: r.address || "", website: r.website || "", phone: r.phone || "", source: "osm" });
    }
  }
  return { gross: cands.length, cands, unavailable };
}

// Google path — for sole-trader / premise trades with no clean SIC. Gives website + phone via place details.
async function viaGoogle(trade, area, locations) {
  const seen = new Set(); const raw = [];
  for (const loc of locations) {
    const s = await post("search", { query: `${trade} in ${loc}`, maxPages: 1 });
    (s.results || []).forEach(r => { if (!seen.has(r.placeId)) { seen.add(r.placeId); raw.push(r); } });
  }
  const byId = {};
  for (let i = 0; i < raw.length; i += 25) { const d = await post("placedetails", { placeIds: raw.slice(i, i + 25).map(c => c.placeId) }); (d.results || []).forEach(x => byId[x.placeId] = x); }
  const cands = [];
  for (const c of raw) {
    const x = byId[c.placeId] || {}; const web = x.website || "";
    cands.push({ name: c.name, area: areaOf(c.address), district: distOf(c.address), postcode: pcOf(c.address), address: c.address || "", website: web, phone: x.phone || "", placeId: c.placeId, source: "google" });
  }
  return { gross: cands.length, cands };
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const trade = String(body.trade || "").trim();
    const area = String(body.area || "").trim().toUpperCase();
    const n = Math.min(Math.max(parseInt(body.n || "0", 10), 0), 200);   // 0 = return the whole de-noised pool
    let locations = (Array.isArray(body.locations) && body.locations.length) ? body.locations : (body.town ? [body.town] : [area]);
    if (!trade || !area) return { statusCode: 200, headers, body: JSON.stringify({ error: "need trade + area" }) };

    // MERGE the free sources. Companies House gives the registered universe for a SIC; OSM gives real
    // premises including sole traders. Either alone comes up thin — CO florists were 28 from CH when the
    // town plainly has more. Google is only used when explicitly asked for (it is the paid one).
    const sics = sicFor(trade);
    const useGoogle = body.google === true;
    const parts = [];
    if (sics) parts.push(await viaCompaniesHouse(trade, area, locations, sics));
    parts.push(await viaOSM(trade, area, locations));
    if (useGoogle) parts.push(await viaGoogle(trade, area, locations));

    const source = [sics ? "companies-house" : null, "osm", useGoogle ? "google" : null].filter(Boolean).join("+");
    const disc = { gross: parts.reduce((a, p) => a + (p.gross || 0), 0), cands: parts.flatMap(p => p.cands || []) };
    const perSource = {};
    parts.forEach(p => (p.cands || []).forEach(c => { perSource[c.source] = (perSource[c.source] || 0) + 1; }));

    // in-area + FREE noise/chain pre-filter + de-dupe by name
    const seenN = new Set(); const clean = [];
    for (const c of disc.cands) {
      if (c.area && c.area !== area) continue;
      if (NOISE.test(c.name) || CHAIN.test(c.name)) continue;
      const k = nkey(c.name); if (seenN.has(k)) continue; seenN.add(k);
      clean.push(c);
    }
    clean.sort((a, b) => (a.district || "").localeCompare(b.district || "") || a.name.localeCompare(b.name));

    // --- persistent knowledge base: SKIP firms you already have, WRITE the new ones back (never re-source /
    // re-pay; the store grows each run). Suppression + write-back both default ON; pass suppress:false or
    // store:false to opt out. Failures here never break discovery — they just fall back to no-KB behaviour.
    let suppressed = 0, stored = 0, pool = clean;
    if (body.suppress !== false || body.store !== false) {
      const dbnk = s => String(s || "").toLowerCase().replace(/&/g, "and").replace(/\b(ltd|limited|llp|plc|the|co)\b/g, "").replace(/[^a-z0-9]/g, "");
      try {
        const chk = await post("kb", { action: "check", area });
        if (chk && chk.ok) {
          const have = new Set((chk.existing || []).map(e => dbnk(e.name) + "|" + String(e.area || "").toUpperCase()));
          const fresh = clean.filter(c => !have.has(dbnk(c.name) + "|" + area));
          suppressed = clean.length - fresh.length;
          if (body.store !== false && fresh.length) {
            const rows = fresh.map(c => ({ name: c.name, area, trade, district: c.district || null, postcode: c.postcode || null, website: c.website || null, phone: c.phone || null, company_number: c.companyNumber || null, source: c.source, status: "discovered" }));
            const up = await post("kb", { action: "upsert", rows });
            if (up && up.ok) stored = up.upserted || 0;
          }
          if (body.suppress !== false) pool = fresh;
        }
      } catch (e) {}
    }

    // geographic spread cap (round-robin by district) over the suppressed pool when n>0; else the whole pool
    let picked = pool;
    if (n > 0) {
      const byD = {}; pool.forEach(c => (byD[c.district] = byD[c.district] || []).push(c));
      const ds = Object.keys(byD).sort(); picked = []; let round = 0;
      while (picked.length < n) { let added = 0; for (const d of ds) { if (picked.length >= n) break; if (byD[d][round]) { picked.push(byD[d][round]); added++; } } if (!added) break; round++; }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ trade, area, source, sics: sics || null, bySource: perSource, osmUnavailable: (parts.find(p=>p && p.unavailable) ? true : false), gross: disc.gross, kept: clean.length, suppressed, stored, returned: picked.length, results: picked }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message }) };
  }
};
