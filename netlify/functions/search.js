// Postcode Prospector — Places search per district (Google Places API New)
const FIELDS = "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.types,places.businessStatus,nextPageToken";

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
        phone: p.nationalPhoneNumber || p.internationalPhoneNumber || "",
        website: p.websiteUri || "",
        rating: p.rating || null,
        reviews: p.userRatingCount || 0,
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
