// Postcode Prospector — Places search per district (Google Places API New)
// Field mask = billing tier. DISCOVERY IS DELIBERATELY PRO-TIER: id/name/address/location/status/types only
// — NO websiteUri or phone. That keeps Text Search on the Pro SKU (~$32/1,000, **5,000 free calls/month**),
// vs the Enterprise SKU that website+phone force (~$35/1,000, only 1,000 free/month). You judge a lead from
// name+address+type+register (no website needed), and fetch website+phone ONLY for the leads you tick, via
// placedetails.js (Place Details Pro — its OWN separate 5,000 free/month). This is the two-stage design:
// find cheaply, buy contact data only for keepers. Do NOT add websiteUri/phone back here — it 5×'s the cost.
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
        phone: p.nationalPhoneNumber || p.internationalPhoneNumber || "",  // back in the mask — outreach + judging
        website: p.websiteUri || "",    // back in the mask — the crawler reads it for the email
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
