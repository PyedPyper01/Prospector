// Postcode Prospector — Companies House Advanced Search by SIC code + postcode area.
// Returns the full registered universe of companies in a category/area (official record).
exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const key = ((process.env.CH_API_KEY || body.chKey || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
    if (!key) return { statusCode: 200, headers, body: JSON.stringify({ error: "No Companies House key. Add CH_API_KEY (free) in Settings or Netlify env vars." }) };
    const sic = (body.sic || "").trim();
    const area = (body.area || "").trim().toUpperCase();
    if (!sic) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing SIC code" }) };
    const auth = "Basic " + Buffer.from(key + ":").toString("base64");

    let items = [], start = 0, total = null;
    const size = 100, maxPages = Math.min(body.maxPages || 5, 10);
    for (let page = 0; page < maxPages; page++) {
      const url = `https://api.company-information.service.gov.uk/advanced-search/companies?sic_codes=${encodeURIComponent(sic)}&company_status=active&size=${size}&start_index=${start}`;
      const r = await fetch(url, { headers: { Authorization: auth } });
      if (!r.ok) {
        if (page === 0) return { statusCode: 200, headers, body: JSON.stringify({ error: "Companies House advanced search failed (" + r.status + ")" }) };
        break;
      }
      const d = await r.json();
      total = d.hits ?? total;
      const batch = d.items || [];
      if (!batch.length) break;
      items = items.concat(batch);
      start += size;
      if (items.length >= (total || 0)) break;
      await new Promise(res => setTimeout(res, 120));
    }

    // filter to the requested postcode area, using the registered office postcode
    const out = items.map(i => {
      const ro = i.registered_office_address || {};
      const pc = (ro.postal_code || "").toUpperCase().trim();
      const m = pc.match(/^([A-Z]{1,2})(\d[A-Z\d]?)/);
      return {
        name: i.company_name,
        companyNumber: i.company_number,
        incorporated: i.date_of_creation || "",
        sic: i.sic_codes || [],
        postcode: pc,
        area: m ? m[1] : "",
        district: m ? m[1] + m[2] : "",
        address: [ro.address_line_1, ro.locality, ro.postal_code].filter(Boolean).join(", ")
      };
    }).filter(c => !area || c.area === area);

    return { statusCode: 200, headers, body: JSON.stringify({ results: out, scanned: items.length, totalMatchingSic: total }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
