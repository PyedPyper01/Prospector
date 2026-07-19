// Postcode Prospector — Places search per district (Google Places API New)
// STAGE 1 = DISCOVERY. Field mask = billing tier. We request ONLY Pro-tier fields
//   (id, displayName, formattedAddress, location, businessStatus, types) → "Text Search Pro" SKU,
//   ~$32/1,000, first 5,000 calls/month FREE. NO websiteUri / phone / rating here — those are bought
//   on demand in STAGE 2 (placedetails.js, a SEPARATE Place Details SKU with its own 5,000/mo free
//   allowance) only for vetted leads the operator has ticked. Sweep wide cheaply; buy contact data
//   only for keepers.
const FIELDS = "places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus,places.types,nextPageToken";

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    if (body.ping) return { statusCode: 200, headers, body: JSON.stringify({ pong: true }) };
    const key = ((process.env.GOOGLE_PLACES_KEY || body.googleKey || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
    if (!key) return { statusCode: 400, headers, body: JSON.stringify({ error: "No Google Places API key. Add GOOGLE_PLACES_KEY env var in Netlify, or paste it in Settings." }) };
    const query = (body.query || "").trim();
    if (!query) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing query" }) };

    let results = [], pageToken = null, pages = 0;
    const maxPages = Math.min(body.maxPages || 2, 3);
    do {
      const payload = { textQuery: query, regionCode: "GB", languageCode: "en" };
      if (pageToken) payload.pageToken = pageToken;
      const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (data.error) return { statusCode: 502, headers, body: JSON.stringify({ error: data.error.message || "Places API error" }) };
      (data.places || []).forEach(p => results.push({
        placeId: p.id,
        name: p.displayName ? p.displayName.text : "",
        address: p.formattedAddress || "",
        location: p.location || null,   // {latitude,longitude} — kept for geo use
        phone: "",                      // STAGE 2 (Place Details, on demand for ticked leads) fills this
        website: "",                    // STAGE 2 fills this; enrichment then crawls it for the email
        rating: null,                   // not fetched (cost without benefit)
        reviews: null,                  // not fetched (cost without benefit)
        types: p.types || [],
        status: p.businessStatus || ""
      }));
      pageToken = data.nextPageToken || null;
      pages++;
      if (pageToken && pages < maxPages) await new Promise(res => setTimeout(res, 350));
    } while (pageToken && pages < maxPages);

    return { statusCode: 200, headers, body: JSON.stringify({ results, pages }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
