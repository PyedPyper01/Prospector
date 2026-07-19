// Postcode Prospector — STAGE 2: on-demand contact details (Google Place Details, New API).
// A SEPARATE billing SKU from Text Search, with its OWN free monthly allowance (~5,000 Pro-tier calls).
// Fetches websiteUri + phone for a specific place ID so enrichment has a URL to crawl for the email.
// Called ONLY for vetted leads the operator has ticked — never automatically on every sweep result.
const FIELDS = "id,websiteUri,nationalPhoneNumber,internationalPhoneNumber";

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    if (body.ping) return { statusCode: 200, headers, body: JSON.stringify({ pong: true }) };
    const key = ((process.env.GOOGLE_PLACES_KEY || body.googleKey || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
    if (!key) return { statusCode: 400, headers, body: JSON.stringify({ error: "No Google Places API key. Add GOOGLE_PLACES_KEY env var in Netlify, or paste it in Settings." }) };

    // accept a batch of place IDs (capped so one call stays inside the function budget)
    let ids = Array.isArray(body.placeIds) ? body.placeIds : (body.placeId ? [body.placeId] : []);
    ids = ids.map(s => String(s || "").trim()).filter(Boolean).slice(0, 25);
    if (!ids.length) return { statusCode: 400, headers, body: JSON.stringify({ error: "No place IDs supplied" }) };

    const results = [];
    let calls = 0;
    for (const id of ids) {
      // Place resource names look like "places/ChIJ…"; accept either the bare id or the full name.
      const name = id.startsWith("places/") ? id : ("places/" + id);
      try {
        const r = await fetch("https://places.googleapis.com/v1/" + name, {
          method: "GET",
          headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS }
        });
        calls++;
        const d = await r.json();
        if (d.error) { results.push({ placeId: id, website: "", phone: "", error: d.error.message || "error" }); }
        else {
          results.push({
            placeId: id,
            website: d.websiteUri || "",
            phone: d.nationalPhoneNumber || d.internationalPhoneNumber || ""
          });
        }
      } catch (e) {
        results.push({ placeId: id, website: "", phone: "", error: e.message });
      }
      await new Promise(res => setTimeout(res, 120)); // gentle pacing
    }
    return { statusCode: 200, headers, body: JSON.stringify({ results, calls }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
