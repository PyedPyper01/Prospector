// Postcode Prospector — Companies House: registered company, SIC, officers (contact name), parent/independence signal
exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const key = ((process.env.CH_API_KEY || body.chKey || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
    if (!key) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true }) };
    const auth = "Basic " + Buffer.from(key + ":").toString("base64");
    const name = (body.name || "").replace(/\s*[-–|].*$/, "").trim();
    if (!name) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true }) };
    const firmPostcode = String(body.postcode || "").toUpperCase().replace(/\s/g, "");

    const sr = await fetch(`https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(name)}&items_per_page=3`, { headers: { Authorization: auth } });
    if (!sr.ok) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: "CH search failed " + sr.status }) };
    const sd = await sr.json();
    const hit = (sd.items || []).find(i => i.company_status === "active") || (sd.items || [])[0];
    if (!hit) return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };

    const num = hit.company_number;
    // MATCH CONFIDENCE — a fuzzy name search collides in every category, so gate consequence severity on it.
    // HIGH only when the name matches closely AND the registered-office postcode corroborates. Callers must
    // treat a non-HIGH match as enrich-only (director names / company number) and NEVER delete on it alone.
    const norm = s => String(s || "").toLowerCase().replace(/\b(ltd|limited|llp|plc|the|co|company|and|&|sons?|funeral|directors?|services?|group)\b/g, "").replace(/[^a-z0-9]/g, "");
    const q = norm(name), t = norm(hit.title);
    const nameClose = q.length >= 3 && t.length >= 3 && (t.startsWith(q.slice(0, 8)) || q.startsWith(t.slice(0, 8)) || t.includes(q) || q.includes(t));
    const snip = String(hit.address_snippet || "").toUpperCase().replace(/\s/g, "");
    const pcFull = firmPostcode && snip.includes(firmPostcode);
    const pcDistrict = firmPostcode && snip.includes(firmPostcode.replace(/\d[A-Z]{2}$/, ""));
    const matchConfidence = (nameClose && (pcFull || pcDistrict)) ? "high" : (nameClose ? "medium" : "low");
    const out = { found: true, companyNumber: num, companyName: hit.title, status: hit.company_status, address: hit.address_snippet || "", matchConfidence, matchReason: `name ${nameClose ? "close" : "loose"} · postcode ${pcFull ? "exact" : pcDistrict ? "district" : "no match"}` };

    const [pr, or_] = await Promise.all([
      fetch(`https://api.company-information.service.gov.uk/company/${num}`, { headers: { Authorization: auth } }),
      fetch(`https://api.company-information.service.gov.uk/company/${num}/officers?items_per_page=5`, { headers: { Authorization: auth } })
    ]);
    if (pr.ok) {
      const pd = await pr.json();
      out.sicCodes = pd.sic_codes || [];
    }
    if (or_.ok) {
      const od = await or_.json();
      out.officers = (od.items || []).filter(o => !o.resigned_on && o.officer_role && o.officer_role.includes("director"))
        .map(o => o.name).slice(0, 3);
    }
    // corporate PSC check — flags group/chain ownership
    try {
      const psc = await fetch(`https://api.company-information.service.gov.uk/company/${num}/persons-with-significant-control?items_per_page=5`, { headers: { Authorization: auth } });
      if (psc.ok) {
        const pd = await psc.json();
        const corp = (pd.items || []).filter(i => i.kind && i.kind.includes("corporate-entity"));
        out.corporateOwners = corp.map(c => c.name);
      }
    } catch {}
    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
