// Companies House discovery — the AUTHORITATIVE, FREE, comprehensive supplier source.
// Every registered firm of a trade in an area, with its REAL registered-office postcode. Reads the PUBLIC
// Companies House advanced-search front-end (no API key needed): trade → SIC code(s); search each of the
// area's towns by registered-office address; parse name / company-number / address / SIC from the results;
// keep only firms whose postcode is genuinely in the target postcode area. St Albans IFAs: 23 here vs 1 on
// Google. Generalises across trades via the SIC map below. Dependency-free (native fetch).

const BASE = "https://find-and-update.company-information.service.gov.uk/advanced-search/get-results";

// trade keyword → Companies House SIC code(s). First key the trade text contains wins.
const SIC = {
  "financial advis": ["66220", "66190", "66300"], "ifa": ["66220", "66190", "66300"], "wealth": ["66300", "66220", "66190"],
  "mortgage": ["66190", "64921"], "pension": ["66300", "66220"], "insurance": ["66220", "66210", "66290"],
  "funeral": ["96030"], "florist": ["47760"], "solicitor": ["69101", "69102", "69109"], "legal": ["69101", "69102", "69109"],
  "accountant": ["69201", "69202", "69203"], "estate agent": ["68310"], "letting": ["68320", "68310"],
  "surveyor": ["71111", "68320"], "architect": ["71111"], "cater": ["56210", "56290"], "wedding": ["56210", "74901", "96090"],
  "care": ["87100", "87300", "88100", "88910"], "nursing": ["87100", "87300"], "domiciliary": ["88100", "87300"], "residential": ["87100", "87300"],
  "optician": ["47782"], "vet": ["75000"], "dentist": ["86230"], "physio": ["86900"], "photographer": ["74201"],
  "will": ["69102", "69109"], "probate": ["69102", "69109"], "celebrant": ["96090"], "memorial": ["96030", "23700"], "mason": ["23700", "43990"],
  "plumb": ["43220"], "electric": ["43210"], "builder": ["41200", "43999"], "landscap": ["81300"], "cleaning": ["81210", "81220"]
};
function sicFor(trade, override) {
  if (override) return String(override).split(/[,\s]+/).filter(Boolean);
  const t = String(trade || "").toLowerCase();
  for (const k in SIC) { if (t.includes(k)) return SIC[k]; }
  return null;
}

const dec = s => String(s || "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const pcOf = a => { const m = String(a || "").toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/); return m ? m[0] : ""; };
const distOf = a => { const m = pcOf(a).match(/^([A-Z]{1,2}\d[A-Z\d]?)/); return m ? m[1] : ""; };
const areaOf = a => { const m = pcOf(a).match(/^([A-Z]{1,2})/); return m ? m[1] : ""; };

function parseRows(html) {
  const out = [];
  const rows = String(html).split('<tr class="govuk-table__row">').slice(1);
  for (const row of rows) {
    const nm = row.match(/href=\/company\/([A-Z0-9]+)[^>]*>([^<]+)</);
    if (!nm) continue;
    const lis = [...row.matchAll(/<li>([^<]*)<\/li>/g)].map(m => dec(m[1]));
    const addr = lis.find(x => pcOf(x)) || "";
    const sicLi = (lis.find(x => /SIC codes/i.test(x)) || "").replace(/SIC codes\s*-\s*/i, "");
    out.push({ name: dec(nm[2]), number: nm[1], address: addr, postcode: pcOf(addr), district: distOf(addr), area: areaOf(addr), sic: sicLi });
  }
  return out;
}

async function fetchPage(sic, location, page) {
  const url = `${BASE}?registeredOfficeAddress=${encodeURIComponent(location)}&sicCodes=${encodeURIComponent(sic)}&status=active` + (page > 1 ? `&page=${page}` : "");
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (PostcodeProspector supplier lookup)" } });
    if (!r.ok) return { rows: [], err: `http ${r.status}` };
    const html = await r.text();
    return { rows: parseRows(html), total: ((html.match(/([\d,]+)\s+results?/i) || [])[1] || "").replace(/,/g, ""), err: null };
  } catch (e) { return { rows: [], err: e.message }; }
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const trade = String(body.trade || "").trim();
    const area = String(body.area || "").trim().toUpperCase();
    let locations = (Array.isArray(body.locations) && body.locations.length) ? body.locations : (body.town ? [body.town] : []);
    const sics = sicFor(trade, body.sic);
    if (!area) return { statusCode: 200, headers, body: JSON.stringify({ error: "need area" }) };
    if (!sics) return { statusCode: 200, headers, body: JSON.stringify({ error: `no SIC mapping for "${trade}" — pass an explicit sic code`, trade }) };
    if (!locations.length) locations = [area];

    const seen = new Set(); const firms = []; let grossTotal = 0;
    for (const loc of locations) {
      for (const sic of sics) {
        for (let page = 1; page <= 6; page++) {
          const { rows, total, err } = await fetchPage(sic, loc, page);
          if (page === 1 && total) grossTotal += (+total || 0);
          if (err || !rows.length) break;
          for (const f of rows) {
            if (seen.has(f.number)) continue;
            if (f.area !== area) continue;      // keep only firms whose postcode is genuinely in this area
            seen.add(f.number); firms.push(f);
          }
          if (rows.length < 20) break;           // last page
        }
      }
    }
    firms.sort((a, b) => (a.district || "").localeCompare(b.district || "") || a.name.localeCompare(b.name));
    return { statusCode: 200, headers, body: JSON.stringify({ area, trade, sics, locations, grossMatches: grossTotal, count: firms.length, results: firms }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message }) };
  }
};
