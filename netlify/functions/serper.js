// Serper — Google Places/Maps results as JSON. Discovery ONLY.
//
// Why this exists: the free sources enumerate names well (OpenStreetMap found 2,550 florists nationally) but
// carry a website on roughly a quarter of them, and the website is the field the sales team cannot work
// without. Serper returns the website directly, at ~$0.30-1 per 1,000 queries against $35/1,000 for Google's
// own Enterprise tier.
//
// IMPORTANT — what we keep. Google's Maps terms forbid storing its Content; only place IDs may be kept
// indefinitely. So this endpoint is a POINTER, not a data source: we carry the website URL across and build
// the stored record by crawling the firm's own site. A URL is a pointer; the firm's own site is theirs to
// publish and ours to read. Do not warehouse the ratings, reviews or descriptions that come back here.
//
// Dependency-free (native fetch).
const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;

async function serper(path, key, body, ms = 20000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch("https://google.serper.dev/" + path, {
      method: "POST", signal: c.signal,
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { ok: r.ok, status: r.status, json: j, raw: txt.slice(0, 400) };
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
  finally { clearTimeout(t); }
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  const key = clean(process.env.SERPER_API_KEY);
  if (!key) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: "SERPER_API_KEY not set in Netlify env" }) };

  try {
    const b = JSON.parse(event.body || "{}");
    const q = String(b.q || "").trim();
    if (!q) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: "need q" }) };
    // DEFAULT TO /maps. The /places endpoint returns no website field whatsoever — only title, address,
    // phone, rating and cid — while /maps returns website, placeId and full opening hours. Since the whole
    // point of this connector is the website, /places is useless here and /maps is the default.
    const path = (b.endpoint === "places") ? "places" : "maps";
    // gl:"uk" alone is NOT enough — "florists in Colchester" returned Colchester, CONNECTICUT first.
    // `location` geo-targets the search itself, which is what actually keeps results in the right country.
    const r = await serper(path, key, { q, gl: "uk", hl: "en",
      ...(b.location ? { location: b.location } : {}),
      // ll pins the search to a point ("@lat,lng,14z"), which geo-targets by OUTCODE CENTROID rather than by
      // town name. Postcode areas have no clean list of towns — CO7's parishes alone number 22 — but every
      // outcode has a free centroid from postcodes.io, so this covers an area uniformly and cheaply.
      ...(b.ll ? { ll: b.ll } : {}),
      ...(b.page ? { page: b.page } : {}) });
    if (!r.ok || !r.json) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: r.status, detail: r.error || r.raw }) };
    }
    const list = r.json.places || r.json.local || r.json.results || [];
    const results = list.map(p => ({
      name: p.title || p.name || "",
      website: p.website || p.link || "",
      phone: p.phoneNumber || p.phone || "",
      address: p.address || "",
      category: p.category || p.type || "",
      lat: p.latitude ?? null, lng: p.longitude ?? null,
      placeId: p.placeId || p.cid || ""      // the ONE Google field that may be stored indefinitely
    })).filter(x => x.name);
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: true, q, endpoint: path, count: results.length,
      withWebsite: results.filter(x => x.website).length,
      sampleRaw: b.debug ? (list[0] || null) : undefined,      // to inspect the real field names once
      results
    }) };
  } catch (e) { return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: e.message }) }; }
};
