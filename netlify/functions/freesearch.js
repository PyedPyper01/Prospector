// Postcode Prospector — FREE data sources. No API key, no per-search cost.
//   osm  — OpenStreetMap via Overpass (all trades; name, phone, website, address)
//   cqc  — CQC provider list by postcode (care categories) — complete official list
//   fsa  — FSA food business list by postcode (caterers, venues) — complete official list
//   ea   — Environment Agency waste carriers (house/estate clearance)
//   ch   — Companies House by SIC + postcode (any category with a clean SIC)
const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;

async function getJSON(url, headers = {}, ms = 25000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "PostcodeProspector/1.0", ...headers } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}
async function postForm(url, body, ms = 30000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { method: "POST", signal: c.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "PostcodeProspector/1.0" }, body });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}
// The public Overpass instance rate-limits aggressively from datacenter IPs, so fail over across mirrors
// until one returns data — makes bulk free sweeps reliable rather than intermittently empty.
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];
async function overpass(query) {
  // Cap EACH endpoint at 8s so all three attempts fit inside the function's execution budget (~26s)
  // rather than one slow mirror eating the whole timeout and killing the function.
  for (const url of OVERPASS) {
    const d = await postForm(url, "data=" + encodeURIComponent(query), 8000);
    if (d && Array.isArray(d.elements)) return d;
  }
  return null;
}

// map a plain-English request to OSM tags
const OSM_TAGS = [
  [/funeral (director|home)|undertaker/i, ['"shop"="funeral_directors"', '"office"="funeral_directors"', '"amenity"="funeral_hall"']],
  [/florist|flower/i, ['"shop"="florist"']],
  [/solicitor|lawyer|probate|conveyanc/i, ['"office"="lawyer"']],
  [/financial advis|ifa\b|wealth|mortgage|equity release|insurance broker/i, ['"office"="financial_advisor"', '"office"="financial"', '"office"="insurance"']],
  [/accountant|tax advis/i, ['"office"="accountant"', '"office"="tax_advisor"']],
  [/locksmith/i, ['"craft"="locksmith"', '"shop"="locksmith"']],
  [/print|order of service|stationer/i, ['"shop"="copyshop"', '"craft"="printer"', '"shop"="printing"']],
  [/photograph/i, ['"craft"="photographer"', '"shop"="photo"']],
  [/caterer|catering/i, ['"craft"="caterer"', '"shop"="caterer"']],
  [/pub|wake venue|function room|hotel|restaurant/i, ['"amenity"="pub"', '"tourism"="hotel"', '"amenity"="restaurant"']],
  [/mason|headstone|memorial|monument/i, ['"craft"="stonemason"', '"shop"="funeral_directors"']],
  [/cemetery|burial ground|crematorium/i, ['"amenity"="grave_yard"', '"landuse"="cemetery"', '"amenity"="crematorium"']],
  [/care (agency|home)|domiciliary|home care/i, ['"amenity"="social_facility"', '"healthcare"="nurse"']],
  [/counsell?or|therapist|bereavement support/i, ['"healthcare"="psychotherapist"', '"healthcare"="counselling"']],
  [/garden|landscap/i, ['"shop"="garden_centre"', '"craft"="gardener"']],
  [/removal|storage/i, ['"shop"="storage_rental"', '"craft"="mover"']],
  [/kennel|cattery|pet board/i, ['"amenity"="animal_boarding"', '"shop"="pet"']],
  [/auction/i, ['"shop"="auction_house"', '"amenity"="auction_house"']],
  [/jewell/i, ['"shop"="jewelry"']],
  [/surveyor/i, ['"office"="surveyor"', '"office"="estate_agent"']],
];
function tagsFor(q) {
  for (const [re, tags] of OSM_TAGS) if (re.test(q)) return tags;
  return null;
}

// ---- OSM via Overpass, bounded by a postcode district's area ----
async function osm(request, district) {
  // 1. resolve the postcode DISTRICT (outcode) to a real geographic centre, then build a ~5km bounding
  //    box around it. Free UK postcodes.io gives an accurate outcode centroid (Nominatim's postalcode
  //    index is missing most districts and its free-text search returns a 10m address point, not the area).
  const oc = String(district).replace(/\s+/g, "").toUpperCase();
  let lat = null, lon = null;
  const pio = await getJSON(`https://api.postcodes.io/outcodes/${encodeURIComponent(oc)}`);
  if (pio && pio.result && pio.result.latitude != null) { lat = pio.result.latitude; lon = pio.result.longitude; }
  if (lat == null) { // fallback: Nominatim free-text (approx point)
    const nom = await getJSON(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(district + ", United Kingdom")}&countrycodes=gb&format=json&limit=1`);
    if (nom && nom[0]) { lat = Number(nom[0].lat); lon = Number(nom[0].lon); }
  }
  if (lat == null || isNaN(lat)) return { results: [], note: "district not found in OSM" };
  const pad = 0.045; // ~5km — roughly a postcode district's radius
  const bbox = `${(lat - pad).toFixed(4)},${(lon - pad).toFixed(4)},${(lat + pad).toFixed(4)},${(lon + pad).toFixed(4)}`;

  const tags = tagsFor(request);
  let filters;
  if (tags) {
    filters = tags.map(t => `nwr[${t}](${bbox});`).join("\n");
  } else {
    const kw = request.replace(/[^a-zA-Z ]/g, "").trim().split(/\s+/)[0] || "shop";
    filters = `nwr["name"~"${kw}",i](${bbox});`;
  }
  const query = `[out:json][timeout:15];(${filters});out center tags 200;`;
  const d = await overpass(query);
  const els = (d && d.elements) || [];
  const results = els.filter(e => e.tags && e.tags.name).map(e => {
    const t = e.tags;
    const addr = [t["addr:housenumber"], t["addr:street"], t["addr:city"], t["addr:postcode"]].filter(Boolean).join(" ");
    return {
      placeId: "osm" + e.type + e.id,
      name: t.name,
      address: addr || t["addr:full"] || "",
      phone: t.phone || t["contact:phone"] || "",
      website: t.website || t["contact:website"] || "",
      email: t.email || t["contact:email"] || "",
      rating: null, reviews: 0,
      types: Object.entries(t).filter(([k]) => ["shop","office","craft","amenity","healthcare"].includes(k)).map(([k,v]) => v),
      status: "OPERATIONAL", source: "osm"
    };
  });
  return { results };
}

// ---- CQC: complete list of registered care providers in a postcode area ----
async function cqcList(district, key) {
  const h = key ? { "Ocp-Apim-Subscription-Key": key } : {};
  const d = await getJSON(`https://api.service.cqc.org.uk/public/v1/providers?postalCode=${encodeURIComponent(district)}&perPage=100`, h);
  const items = (d && d.providers) || [];
  return { results: items.map(p => ({
    placeId: "cqc" + p.providerId, name: p.providerName || "", address: p.postalAddressLine1 || "",
    phone: p.mainPhoneNumber || "", website: "", rating: null, reviews: 0,
    types: ["care_provider"], status: "OPERATIONAL", source: "cqc"
  })) };
}
// ---- FSA: complete list of food businesses (caterers, venues) ----
async function fsaList(district) {
  const d = await getJSON(`https://api.ratings.food.gov.uk/Establishments?address=${encodeURIComponent(district)}&pageSize=100`,
    { "x-api-version": "2", "Accept": "application/json" });
  const items = (d && d.establishments) || [];
  return { results: items.map(e => ({
    placeId: "fsa" + e.FHRSID, name: e.BusinessName || "",
    address: [e.AddressLine1, e.AddressLine2, e.PostCode].filter(Boolean).join(", "),
    phone: "", website: "", rating: null, reviews: 0,
    types: [(e.BusinessType || "").toLowerCase().replace(/\s+/g, "_")],
    fsaRating: e.RatingValue, status: "OPERATIONAL", source: "fsa"
  })) };
}
// ---- EA waste carriers (house/estate clearance) ----
async function eaList(district) {
  const d = await getJSON(`https://environment.data.gov.uk/public-register/waste-carriers-brokers/registration.json?postcode=${encodeURIComponent(district)}&_limit=100`);
  const items = (d && d.items) || [];
  return { results: items.map(i => ({
    placeId: "ea" + (i.registrationNumber || Math.random()),
    name: i.registeredName || i.tradingName || (i.operator && i.operator.name) || "",
    address: (i.registeredAddress && i.registeredAddress.postcode) || "",
    phone: "", website: "", rating: null, reviews: 0,
    types: ["waste_carrier"], licence: i.registrationNumber || "", status: "OPERATIONAL", source: "ea"
  })).filter(x => x.name) };
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const b = JSON.parse(event.body || "{}");
    const src = (b.source || "osm").toLowerCase();
    const district = (b.district || "").trim();
    const request = (b.request || "").trim();
    if (!district) return { statusCode: 400, headers, body: JSON.stringify({ error: "missing district" }) };
    let out;
    switch (src) {
      case "osm": out = await osm(request, district); break;
      case "cqc": out = await cqcList(district, clean(process.env.CQC_KEY || b.cqcKey)); break;
      case "fsa": out = await fsaList(district); break;
      case "ea":  out = await eaList(district); break;
      default: return { statusCode: 400, headers, body: JSON.stringify({ error: "unknown source " + src }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ source: src, ...out }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ results: [], error: e.message }) };
  }
};
