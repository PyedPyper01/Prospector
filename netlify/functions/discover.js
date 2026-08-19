// In-app discovery for a trade + postcode area. Free sources only.
//
// SCOPE — deliberately narrow. This endpoint is NOT the main sourcing route any more. Real sourcing is done
// by web research (trade-body directories, then search) run from Claude Code, which returns firms WITH their
// websites: 96% coverage against 0% for the old Companies House path. What remains here is OpenStreetMap,
// which maps actual premises and carries website/phone tags, as a quick top-up for one area at a time.
//
// Companies House was removed in Aug 2026 — see the note in the handler for why.
// Google Places is available but OFF unless explicitly requested: it is the only paid source and the standing
// instruction is free sources only.
//
// Everything returned must be (a) the trade asked for and (b) carry a website. A row failing either test is
// not a lead — it is work for someone else later — so it is dropped here rather than stored and cleaned up
// afterwards. Counts for what was dropped and why come back in the response.

const SITE = "https://postcodeprospector.netlify.app/.netlify/functions";

// Companies House SIC lookup removed with the CH source — see the note in the handler below.

// WRONG-TRADE gate. Each entry lists what is NOT the trade, matched against the firm's name and domain.
// These are the confusions the free sources actually produce — every florist pattern below came from a real
// row in the store (ZCSucculents, The Reptile Hut, Swallow Aquatics, Greenbrook Garden Centre).
const OFF_TRADE = [
  [/florist|flower/i, /succulent|reptile|aquatic|aquarium|tropical fish|pet |pets\b|petshop|pet shop|garden centre|garden center|nurser(y|ies)|seeds?\b|fertili[sz]|equestrian|feed ?store|coral|vivarium/i],
  [/funeral director/i, /crematori|cemetery|memorial|mason|florist|monumental/i],
  [/mason|monumental|headstone/i, /worktop|kitchen|bathroom|tiling|tiles|paving|driveway|landscap|fireplace|granite worktop/i],
  [/locksmith/i, /auto ?locksmith|car key|key cutting kiosk|hardware|diy|timpson/i],
  [/solicitor|probate|conveyanc/i, /recruit|training|marketing|will writing software/i],
  [/celebrant/i, /wedding planner|photograph|venue hire/i],
  [/photographer/i, /photo booth|passport photo|framing|print shop/i],
  [/caterer|catering/i, /equipment|supplies|hire ?company|disposable/i],
];
function offTradeFor(trade) {
  const t = String(trade || "").toLowerCase();
  for (const [re, bad] of OFF_TRADE) if (re.test(t)) return bad;
  return null;
}

// FREE noise filter — Companies House shares SIC codes across consumer firms and their admin/fund shells.
const NOISE = /\b(holdings?|nominees?|trustees?|administrat(or|ion)|liquidity|custodian|deppositary|securitisation|special purpose|spv|bidco|topco|midco|newco|propco|holdco|\b(gp|lp) (limited|ltd)|(no|number) ?\d+ (gp|lp)\b|fund (i{1,3}|iv|v|management|services)|capital partners|private equity|ventures? (fund|capital)|sipp|ssas|self.?invested)\b/i;
const CHAIN = /\b(st\.? ?james|\bsjp\b|quilter|openwork|true potential|nfu mutual|dignity|co-?op|funeral partners|interflora|specsavers|foxtons|connells|hays travel)\b/i;

const pcOf = a => { const m = String(a || "").toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/); return m ? m[0] : ""; };
const distOf = a => { const m = pcOf(a).match(/^([A-Z]{1,2}\d[A-Z\d]?)/); return m ? m[1] : ""; };
const areaOf = a => { const m = pcOf(a).match(/^([A-Z]{1,2})/); return m ? m[1] : ""; };
const nkey = s => String(s || "").toLowerCase().replace(/&/g, "and").replace(/\b(ltd|limited|llp|plc|the|co)\b/g, "").replace(/[^a-z0-9]/g, "");

async function post(fn, body) { try { const r = await fetch(SITE + "/" + fn, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return await r.json(); } catch (e) { return { error: e.message }; } }

// Companies House path — comprehensive, free, real postcodes; website comes later in enrich.

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

    // Companies House was REMOVED as a discovery source (Aug 2026). It maps company REGISTRATIONS, not
    // premises, and two things followed from that:
    //   1. It holds no website field, so of 804 rows sourced this way exactly 2 had a website — and a website
    //      is the one field the sales team actually needs.
    //   2. Its SIC codes bundle unrelated trades. 47760 is officially "Retail sale of flowers, plants, seeds,
    //      fertilizers, PET ANIMALS and pet food", so asking for florists correctly returned reptile shops,
    //      aquatics centres, garden centres and fertiliser importers — 25% of that list was off-trade.
    // Free web research (directories + search, run from Claude Code) returns 96% with websites. That is the
    // route for discovery now; this endpoint keeps only OSM, which maps real premises and carries site tags.
    const useGoogle = body.google === true;
    const parts = [];
    parts.push(await viaOSM(trade, area, locations));
    if (useGoogle) parts.push(await viaGoogle(trade, area, locations));

    const source = ["osm", useGoogle ? "google" : null].filter(Boolean).join("+");
    const disc = { gross: parts.reduce((a, p) => a + (p.gross || 0), 0), cands: parts.flatMap(p => p.cands || []) };
    const perSource = {};
    parts.forEach(p => (p.cands || []).forEach(c => { perSource[c.source] = (perSource[c.source] || 0) + 1; }));

    // in-area + noise/chain pre-filter + WRONG-TRADE gate + WEBSITE gate + de-dupe by name.
    //
    // The last two are the point of this block. Previously anything discovered was stored and then cleaned up
    // downstream, which is how a florist list ended up 25% garden centres, pet shops and aquatics dealers with
    // no websites. A row that is the wrong trade, or has no website, is not a lead — so it never gets stored.
    const seenN = new Set(); const clean = [];
    const dropped = { outOfArea: 0, noise: 0, wrongTrade: 0, noWebsite: 0, duplicate: 0 };
    const offTrade = offTradeFor(trade);
    for (const c of disc.cands) {
      if (c.area && c.area !== area) { dropped.outOfArea++; continue; }
      if (NOISE.test(c.name) || CHAIN.test(c.name)) { dropped.noise++; continue; }
      if (offTrade && offTrade.test((c.name || "") + " " + (c.website || ""))) { dropped.wrongTrade++; continue; }
      if (!String(c.website || "").trim()) { dropped.noWebsite++; continue; }
      const k = nkey(c.name); if (seenN.has(k)) { dropped.duplicate++; continue; } seenN.add(k);
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

    return { statusCode: 200, headers, body: JSON.stringify({ trade, area, source, bySource: perSource, osmUnavailable: (parts.find(p=>p && p.unavailable) ? true : false), gross: disc.gross, kept: clean.length, dropped, suppressed, stored, returned: picked.length, results: picked }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message }) };
  }
};
