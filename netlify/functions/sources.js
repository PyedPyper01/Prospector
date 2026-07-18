// Postcode Prospector — SOURCE ROUTER (directory sweeps).
// The trade-directory counterpart to the authority router. Given ONE source id + an area,
// it fetches that source's listings and returns a normalised candidate list. The frontend
// calls this once per source in the category's source list, then merges/dedupes across all
// of them into the pool that flows into Enrich → Vet & Rank.
//
// Why one source per invocation: each directory is a separate network job with its own
// timeout risk; isolating them means a slow/blocked source can never kill the whole sweep —
// the frontend just logs it and keeps the others.
//
// Funeral-director sources wired tonight (the test category):
//   saif          — SAIF member JSON (Agile Store Locator dump). Trade body → category-clean.
//                   ONE GET returns every member; we filter by postcode area. Robust, complete.
//   nafd          — NAFD directory at funeral-directory.co.uk (autocomplete → town slug → cards).
//   funeralguide  — funeralguide.co.uk server-rendered tiles (REQUIRES a browser User-Agent).
//   localfuneral  — localfuneral.co.uk town pages (data in window.__INITIAL_STATE__ JSON).
// Anything else (fca/unbiased/vouchedfor/sra/step/cqc/…) returns {status:"not-implemented"}
// so other categories can be configured now and proven later without breaking the sweep.

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HDR = { headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" } };

// -------- small helpers (dependency-free) --------
function decodeEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/&amp;/g, "&").replace(/&#0?38;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#0?34;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/g, "'").replace(/&lsquo;|&rsquo;|&#8217;|&#8216;/g, "'")
    .replace(/&ndash;|&#8211;|–/g, "-").replace(/&mdash;|&#8212;|—/g, "-")
    .replace(/&nbsp;|&#0?160;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(+n); } catch { return " "; } })
    .replace(/\s+/g, " ").trim();
}
const PC_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
function postcodeFrom(text) {
  const m = String(text || "").toUpperCase().match(PC_RE);
  return m ? (m[1] + " " + m[2]) : "";
}
const areaOf = pc => (String(pc || "").toUpperCase().match(/^[A-Z]{1,2}/) || [""])[0];
const districtOf = pc => (String(pc || "").toUpperCase().match(/^[A-Z]{1,2}\d[A-Z\d]?/) || [""])[0];
const slugify = s => String(s || "").toLowerCase().trim().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
// String-aware balanced-brace extractor — pulls a whole JSON object out of a page even when
// it's followed by `;`, more script, or newlines (a plain regex can't match braces reliably).
function balancedJSON(s, marker) {
  const at = s.indexOf(marker); if (at < 0) return null;
  let i = s.indexOf("{", at); if (i < 0) return null;
  const start = i; let depth = 0, inStr = false, esc = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

async function fetchText(url, { ms = 8000, ua = BROWSER_UA, accept = "text/html,application/xhtml+xml,*/*;q=0.8", headers = {} } = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow",
      headers: { "User-Agent": ua, "Accept": accept, "Accept-Language": "en-GB,en;q=0.9", ...headers } });
    const code = r.status;
    if (!r.ok) return { html: "", code };
    return { html: await r.text(), code };
  } catch (e) { return { html: "", code: 0, err: e.name === "AbortError" ? "timeout" : e.message }; }
  finally { clearTimeout(t); }
}
// JSON GET with an optional auth header (CQC etc.). Returns parsed object or null.
async function fetchJSON(url, headers = {}, ms = 7000) {
  const r = await fetchText(url, { ms, accept: "application/json,*/*", headers });
  if (!r.html) return null;
  try { return JSON.parse(r.html); } catch { return null; }
}

// A candidate as every source returns it. Missing fields stay empty; Enrich fills the rest.
function candidate(o) {
  return {
    name: decodeEntities(o.name || ""),
    address: decodeEntities(o.address || ""),
    postcode: (o.postcode || postcodeFrom(o.address)).toUpperCase(),
    phone: (o.phone || "").toString().trim(),
    website: (o.website || "").toString().trim(),
    email: (o.email || "").toString().trim().toLowerCase(),
    contact: decodeEntities(o.contact || ""),
    rating: o.rating != null ? o.rating : null,
    reviews: o.reviews != null ? o.reviews : 0,
    types: o.types || [],
    memberType: o.memberType || "",
    sourceUrl: o.sourceUrl || ""
  };
}
// Does a candidate's postcode fall in the swept area (and, if given, the district set)?
function inArea(pc, area, districtSet) {
  if (!pc) return false;
  if (area && areaOf(pc) !== area.toUpperCase()) return false;
  if (districtSet && districtSet.size && !districtSet.has(districtOf(pc))) return false;
  return true;
}

// ============================ SAIF ============================
// One JSON dump of the whole membership, cached at module scope (survives warm invocations).
let _saifCache = null, _saifAt = 0;
const SAIF_URL = "https://saif.org.uk/wp-admin/admin-ajax.php?action=asl_load_stores&load_all=1&layout=0";
async function saifAll() {
  const now = Date.now();
  if (_saifCache && (now - _saifAt) < 10 * 60 * 1000) return _saifCache;   // 10-min cache
  const r = await fetchText(SAIF_URL, { ms: 9000, accept: "application/json,*/*" });
  if (!r.html) throw new Error(r.err || ("HTTP " + r.code));
  let arr; try { arr = JSON.parse(r.html); } catch { throw new Error("bad JSON"); }
  if (!Array.isArray(arr)) throw new Error("unexpected shape");
  _saifCache = arr; _saifAt = now;
  return arr;
}
async function saif({ area, districtSet, town }) {
  let arr;
  try { arr = await saifAll(); } catch (e) { return { status: "error", results: [], note: "SAIF fetch failed: " + e.message }; }
  const areaU = (area || "").toUpperCase(), townL = (town || "").toLowerCase();
  const out = [];
  for (const m of arr) {
    if ((m.member_type || "") !== "FD") continue;               // funeral directors only (drop Associates/Partnerships)
    const pc = (m.postal_code || "").toUpperCase().trim();
    const city = decodeEntities(m.city || "");
    const hit = areaU ? inArea(pc, areaU, districtSet) : (townL && city.toLowerCase() === townL);
    if (!hit) continue;
    const address = [m.street, m.city, m.state, m.postal_code].map(x => decodeEntities(x || "")).filter(Boolean).join(", ");
    out.push(candidate({ name: m.title, address, postcode: pc, phone: m.phone, website: m.website, email: m.email,
      memberType: "SAIF", sourceUrl: m.website || "" }));
  }
  return { status: out.length ? "ok" : "empty", results: out, note: `${out.length} SAIF member(s) in area` };
}

// ============================ NAFD (funeral-directory.co.uk) ============================
const ND_BASE = "https://www.funeral-directory.co.uk";
async function ndSlugFor(term) {
  const r = await fetchText(`${ND_BASE}/funeral-directors/autocomplete/?search=${encodeURIComponent(term)}`, { ms: 6000, accept: "*/*" });
  if (!r.html) return null;
  const m = r.html.match(/href="(\/funeral-directors\/[a-z0-9-]+\/[a-z0-9-]+\/)"/i);   // first county/town suggestion
  return m ? m[1] : null;
}
function ndParseListing(html) {
  const out = [];
  const blocks = html.split(/<div id="listing-\d+"/i).slice(1);
  for (const b of blocks) {
    // the name link: <a class="details-link …" @click="…" href="/funeral-director/<slug>/"> 1. Name </a>
    const linkM = b.match(/<a[^>]*href="(\/funeral-director\/[a-z0-9-]+\/)"[^>]*>\s*(?:\d+\.\s*)?([^<]+?)\s*<\/a>/i)
      || b.match(/<a[^>]*class="[^"]*details-link[^"]*"[^>]*>\s*(?:\d+\.\s*)?([^<]+?)\s*<\/a>/i);
    const addrM = b.match(/class="[^"]*text-gray-500[^"]*"[^>]*>\s*([^<]+?)\s*<\/p>/i);
    if (!linkM) continue;
    const href = /funeral-director/.test(linkM[1] || "") ? linkM[1] : (b.match(/href="(\/funeral-director\/[a-z0-9-]+\/)"/i) || ["", ""])[1];
    const nameM = [null, linkM[2] != null ? linkM[2] : linkM[1]];
    // postcode: the detail slug tail encodes it, e.g. .../hunnaball-of-colchester-co27qt/
    let pc = "";
    const slugPc = href.match(/-([a-z]{1,2}\d[a-z\d]?)(\d[a-z]{2})\/$/i);
    if (slugPc) pc = (slugPc[1] + " " + slugPc[2]).toUpperCase();
    if (!pc && addrM) pc = postcodeFrom(addrM[1]);
    out.push(candidate({ name: nameM[1], address: addrM ? addrM[1] : "", postcode: pc,
      memberType: "NAFD", sourceUrl: href ? ND_BASE + href : "" }));
  }
  return out;
}
async function nafd({ area, districtSet, districts, town, deadline }) {
  const terms = [];
  if (town) terms.push(town);
  (districts || []).forEach(d => terms.push(d));           // district codes as search terms (CO9, CO13…)
  // Phase 1 — resolve terms → unique town-slugs, in a concurrency pool (fast autocompletes).
  const seenSlug = new Set();
  let ti = 0;
  const resolver = async () => {
    while (ti < terms.length && Date.now() < deadline - 3000) {
      const slug = await ndSlugFor(terms[ti++]).catch(() => null);
      if (slug) seenSlug.add(slug);
    }
  };
  await Promise.all(Array.from({ length: 5 }, resolver));
  // Phase 2 — fetch each unique listing page in a pool, bounded by the deadline.
  const slugs = [...seenSlug];
  const results = [], byKey = new Set();
  let blocked = false, fetched = 0, si = 0;
  const puller = async () => {
    while (si < slugs.length && Date.now() < deadline) {
      const r = await fetchText(`${ND_BASE}${slugs[si++]}`, { ms: 6000 });
      fetched++;
      if (r.code === 403 || r.code === 429 || r.code === 503) { blocked = true; continue; }
      if (!r.html) continue;
      for (const c of ndParseListing(r.html)) {
        if (area && !inArea(c.postcode, area, districtSet)) continue;   // town-mode keeps all (queries already localise)
        const k = slugify(c.name) + "|" + c.postcode.replace(/\s/g, "");
        if (byKey.has(k)) continue; byKey.add(k);
        results.push(c);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, puller));
  const status = results.length ? "ok" : (blocked ? "blocked" : "empty");
  return { status, results, note: `${results.length} NAFD listing(s) from ${fetched}/${slugs.length} town page(s)` + (blocked ? " (some pages blocked)" : "") };
}

// ============================ Funeral Guide ============================
const FG_BASE = "https://www.funeralguide.co.uk";
function fgParseTiles(html) {
  const out = [];
  const blocks = html.split(/<li class="c_fd_tile/i).slice(1);
  for (const b of blocks) {
    const nameM = b.match(/class="c_fd_tile__title"[^>]*>\s*([^<]+?)\s*<\/[a-z0-9]+>/i);
    const addrM = b.match(/class="c_fd_tile__address"[^>]*>\s*([^<]+?)\s*<\/address>/i);
    const hrefM = b.match(/class="c_fd_tile__link"[^>]*href="([^"]+)"/i) || b.match(/href="([^"]+)"[^>]*class="c_fd_tile__link"/i);
    if (!nameM) continue;
    const addr = addrM ? addrM[1] : "";
    const starM = b.match(/icon-stars--(\d)/i);
    const revM = b.match(/is-review-count"[^>]*>\s*([\d,]+)/i);
    out.push(candidate({ name: nameM[1], address: addr, postcode: postcodeFrom(addr),
      rating: starM ? +starM[1] : null, reviews: revM ? +revM[1].replace(/,/g, "") : 0,
      memberType: "", sourceUrl: hrefM ? hrefM[1] : "" }));
  }
  return out;
}
async function funeralguide({ area, districtSet, districts, town, deadline }) {
  const queries = [];
  (districts || []).forEach(d => queries.push(d));
  if (!queries.length && town) queries.push(town);
  const results = [], byKey = new Set();
  let blocked = false, done = 0;
  // small concurrency pool, bounded by the deadline
  const pool = 4;
  let qi = 0;
  const worker = async () => {
    while (qi < queries.length && Date.now() < deadline) {
      const q = queries[qi++];
      const r = await fetchText(`${FG_BASE}/funeral-directors?q=${encodeURIComponent(q)}`, { ms: 6000 });
      done++;
      if (r.code === 403) { blocked = true; continue; }
      if (!r.html) continue;
      for (const c of fgParseTiles(r.html)) {
        if (area && !inArea(c.postcode, area, districtSet)) continue;   // town-mode keeps all
        const k = slugify(c.name) + "|" + c.postcode.replace(/\s/g, "");
        if (byKey.has(k)) continue; byKey.add(k);
        results.push(c);
      }
    }
  };
  await Promise.all(Array.from({ length: pool }, worker));
  const status = results.length ? "ok" : (blocked ? "blocked" : "empty");
  return { status, results, note: `${results.length} Funeral Guide tile(s) from ${done} query point(s)` + (blocked ? " (UA blocked on some)" : "") };
}

// ============================ localfuneral.co.uk ============================
const LF_BASE = "https://localfuneral.co.uk";
// Only ~148 town pages exist (no postcode routes). Map the town we're sweeping to a slug.
async function localfuneral({ area, districtSet, town, deadline }) {
  const slug = slugify(town || "");
  if (!slug) return { status: "empty", results: [], note: "localfuneral needs a town name (no postcode routes)" };
  const results = [], byKey = new Set();
  let pageCount = 1, blocked = false;
  for (let page = 1; page <= pageCount && page <= 6 && Date.now() < deadline; page++) {
    const url = `${LF_BASE}/find-funeral-directors/${slug}` + (page > 1 ? `/page:${page}` : "");
    const r = await fetchText(url, { ms: 6000 });
    if (r.code === 404) return { status: "empty", results, note: `localfuneral has no page for "${town}"` };
    if (r.code === 403 || r.code === 429) { blocked = true; break; }
    if (!r.html) break;
    const raw = balancedJSON(r.html, "__INITIAL_STATE__");
    if (!raw) break;
    let state; try { state = JSON.parse(raw); } catch { break; }
    if (state.pagination && state.pagination.pageCount) pageCount = Math.min(+state.pagination.pageCount, 6);
    for (const fd of (state.funeralDirectors || [])) {
      const pc = postcodeFrom(fd.address || fd.shortAddress || "");
      if (area && !inArea(pc, area, districtSet)) continue;   // town-mode keeps all
      const k = slugify(fd.name) + "|" + pc.replace(/\s/g, "");
      if (byKey.has(k)) continue; byKey.add(k);
      results.push(candidate({ name: fd.name, address: fd.address, postcode: pc,
        phone: fd.renderedTrackedNumber || fd.trackedNumber || "", memberType: "", sourceUrl: fd.slug ? `${LF_BASE}/funeral-director/${fd.slug}` : "" }));
    }
    await new Promise(res => setTimeout(res, 200));
  }
  return { status: results.length ? "ok" : (blocked ? "blocked" : "empty"), results, note: `${results.length} localfuneral listing(s) for "${town}"` };
}

// ============================ VouchedFor (IFAs — advisers by postcode) ============================
// Next.js page: adviser data is embedded as JSON in <script id="__NEXT_DATA__">. Plain fetch, no key.
// Distinguishes ifa / fa_restricted / mortgage_adviser / accountant — we keep advisers, drop the rest.
function vfParse(html) {
  const at = html.indexOf("__NEXT_DATA__"); if (at < 0) return [];
  const raw = balancedJSON(html.slice(at), "{"); if (!raw) return [];
  let j; try { j = JSON.parse(raw); } catch { return []; }
  const pros = ((((j.props || {}).pageProps || {}).initialProfessionals || {}).data) || [];
  const out = [];
  for (const p of pros) {
    const type = (p.type || "").toLowerCase();
    if (/mortgage|accountant/.test(type)) continue;                 // this vertical is IFAs — drop brokers/accountants
    const firm = decodeEntities(p.firm_name || "");
    if (!firm) continue;
    out.push(candidate({
      name: firm, address: decodeEntities(p.home_town || (p.permalink && p.permalink.town) || ""), postcode: "",
      phone: p.phone_number || "", rating: p.review_average_score != null ? Number(p.review_average_score) : null,
      reviews: p.review_count || 0, contact: [p.first_name, p.last_name].filter(Boolean).join(" "),
      memberType: type === "ifa" ? "VouchedFor IFA" : "VouchedFor adviser",
      sourceUrl: (p.permalink && p.permalink.url) ? ("https://www.vouchedfor.co.uk" + p.permalink.url) : ""
    }));
  }
  return out;
}
async function vouchedfor({ districts, town, deadline }) {
  const queries = (districts && districts.length) ? districts.slice(0, 16) : (town ? [town] : []);
  if (!queries.length) return { status: "empty", results: [], note: "no district/town for VouchedFor" };
  const results = [], byKey = new Set(); let done = 0, blocked = false, qi = 0;
  const worker = async () => {
    while (qi < queries.length && Date.now() < deadline) {
      const q = queries[qi++];
      const r = await fetchText(`https://www.vouchedfor.co.uk/IFA-financial-advisor-mortgage/${encodeURIComponent(String(q).toLowerCase())}`, { ms: 6000 });
      done++;
      if (r.code === 403) { blocked = true; continue; }
      if (!r.html) continue;
      for (const c of vfParse(r.html)) {
        const k = slugify(c.name) + "|" + (c.phone.replace(/\D/g, "") || slugify(c.address));
        if (byKey.has(k)) continue; byKey.add(k); results.push(c);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { status: results.length ? "ok" : (blocked ? "blocked" : "empty"), results, note: `${results.length} VouchedFor adviser(s) from ${done} query point(s)` };
}

// ============================ RICS Find a Surveyor ============================
// Direct JSON API (Umbraco). All six params required even when blank. Real postcodes in `address`.
async function rics({ area, districtSet, town, deadline }) {
  const loc = town || area; if (!loc) return { status: "empty", results: [], note: "RICS needs a town/area name" };
  const results = [], byKey = new Set(); let blocked = false, pageCount = 1, fetched = 0;
  for (let page = 1; page <= pageCount && page <= 6 && Date.now() < deadline; page++) {
    const url = `https://www.ricsfirms.com/umbraco/api/surveyorSearchApi/results?location=${encodeURIComponent(loc)}&firmName=&keyword=&lon=&lat=&boxId=&page=${page}`;
    const j = await fetchJSON(url, {}, 6000);
    fetched++;
    if (!j) { if (page === 1) blocked = true; break; }
    if (j.pageCount) pageCount = Math.min(+j.pageCount, 6);
    for (const o of (j.resultOffices || []).concat(j.resultFeaturedOffices || [])) {
      const pc = postcodeFrom(o.address);
      if (area && !inArea(pc, area, districtSet)) continue;
      const k = slugify(o.firmName) + "|" + pc.replace(/\s/g, "");
      if (byKey.has(k)) continue; byKey.add(k);
      results.push(candidate({ name: o.firmName, address: o.address, postcode: pc, phone: o.telephone,
        website: o.websiteUrl || o.website, email: o.email, memberType: o.ricsRegulated ? "RICS-regulated" : "RICS",
        sourceUrl: o.firmNameUrlSafe ? `https://www.ricsfirms.com/surveyors/${o.firmNameUrlSafe}/` : "" }));
    }
    await new Promise(res => setTimeout(res, 150));
  }
  return { status: results.length ? "ok" : (blocked ? "blocked" : "empty"), results, note: `${results.length} RICS firm(s) near ${loc}${blocked ? " (API blocked)" : ""}` };
}

// ============================ CQC (care providers) ============================
// Needs a free subscription key (Ocp-Apim-Subscription-Key). No postcode filter — enumerate by
// localAuthority (the town is the best proxy), client-filter by postcode area, then N+1 detail for rating.
async function cqcSource({ area, districtSet, town, deadline, cqcKey }) {
  if (!cqcKey) return { status: "blocked", results: [], note: "CQC needs a free subscription key — set CQC_KEY env var (api-portal.service.cqc.org.uk) or paste it in Settings" };
  const la = town || area; if (!la) return { status: "empty", results: [], note: "CQC needs a town (used as the local-authority filter)" };
  const h = { "Ocp-Apim-Subscription-Key": cqcKey };
  const partner = "PostcodeProspector";
  const list = []; let page = 1, totalPages = 1;
  while (page <= totalPages && page <= 5 && Date.now() < deadline - 2500) {
    const j = await fetchJSON(`https://api.service.cqc.org.uk/public/v1/locations?localAuthority=${encodeURIComponent(la)}&perPage=500&page=${page}&partnerCode=${partner}`, h, 7000);
    if (!j) { if (page === 1) return { status: "blocked", results: [], note: `CQC returned no data (check key, or localAuthority "${la}")` }; break; }
    totalPages = j.totalPages || 1;
    (j.locations || []).forEach(l => list.push(l));
    page++;
  }
  const scoped = list.filter(l => !area || inArea((l.postalCode || "").toUpperCase(), area, districtSet));
  const results = []; let li = 0, detailed = 0;
  const worker = async () => {
    while (li < scoped.length && Date.now() < deadline) {
      const loc = scoped[li++];
      let rating = "", careHome = "";
      if (detailed < 45 && Date.now() < deadline - 700) {
        const d = await fetchJSON(`https://api.service.cqc.org.uk/public/v1/locations/${loc.locationId}?partnerCode=${partner}`, h, 6000);
        detailed++;
        if (d) { rating = (d.currentRatings && d.currentRatings.overall && d.currentRatings.overall.rating) || ""; careHome = d.careHome || ""; }
      }
      results.push(candidate({ name: loc.locationName, postcode: (loc.postalCode || "").toUpperCase(),
        types: careHome === "Y" ? ["care_home"] : (careHome === "N" ? ["home_care"] : []),
        memberType: rating ? `CQC ${rating}` : "CQC-registered", sourceUrl: `https://www.cqc.org.uk/location/${loc.locationId}` }));
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  return { status: results.length ? "ok" : "empty", results, note: `${results.length} CQC location(s) in ${la}${detailed ? ` (${detailed} with ratings)` : ""}` };
}

// ============================ dispatcher ============================
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...HDR.headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const b = JSON.parse(event.body || "{}");
    const source = (b.source || "").toLowerCase().trim();
    const area = (b.area || "").toUpperCase().trim();
    const town = (b.town || "").trim();
    const districts = (b.districts || []).map(d => String(d).toUpperCase().trim()).filter(Boolean);
    const districtSet = new Set(districts);
    const deadline = Date.now() + Math.min(Math.max(+b.budgetMs || 8000, 3000), 9000);  // internal time budget (< Netlify 10s)
    const cqcKey = ((process.env.CQC_KEY || b.cqcKey || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
    const ctx = { area, town, districts, districtSet, deadline, cqcKey };

    let out;
    switch (source) {
      case "saif":         out = await saif(ctx); break;
      case "nafd":         out = await nafd(ctx); break;
      case "funeralguide": out = await funeralguide(ctx); break;
      case "localfuneral": out = await localfuneral(ctx); break;
      case "vouchedfor":   out = await vouchedfor(ctx); break;
      case "rics":         out = await rics(ctx); break;
      case "cqc":          out = await cqcSource(ctx); break;
      // Known-but-not-fetchable connectors — return a clear reason so the sweep logs it and falls back to Google.
      case "fca":          out = { status: "not-a-lister", results: [], note: "FCA has no geographic search — it's a per-firm permission VERIFIER; run the register-verify pass over the pool" }; break;
      case "sra":          out = { status: "not-a-lister", results: [], note: "SRA Find-a-Solicitor is reCAPTCHA-gated — use Google + the SRA verify link" }; break;
      case "step":         out = { status: "not-a-lister", results: [], note: "STEP directory is Cloudflare-gated — use Google + a verify link" }; break;
      case "unbiased":     out = { status: "not-a-lister", results: [], note: "Unbiased is now a 2-firm lead-gen funnel — superseded by VouchedFor" }; break;
      default:             out = { status: "not-implemented", results: [], note: `source "${source}" is configured but not yet wired` };
    }
    return { statusCode: 200, ...HDR, body: JSON.stringify({ source, ...out, count: (out.results || []).length }) };
  } catch (e) {
    // Never throw — a source failure must not kill the sweep.
    return { statusCode: 200, ...HDR, body: JSON.stringify({ source: "", status: "error", results: [], count: 0, note: e.message }) };
  }
};
