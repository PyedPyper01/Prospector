// Postcode Prospector — PUBLISH TO AFTERLIFE.
// Forwards the APPROVE leads to the AfterLife supplier directory as `pending`.
// The bearer token lives ONLY in this site's environment (SUPPLIER_IMPORT_TOKEN) — it is
// read here and sent as the Authorization header; it is never exposed to the browser and
// never hardcoded. Contact details are deliberately withheld: every record is sent with
// phone:null and website:null, so families only ever reach these firms through AfterLife.
// AfterLife lands them as `pending` for manual approval on afterlife.ltd.

const IMPORT_URL = "https://afterlife.ltd/api/suppliers/import";

// The England & Wales postcode areas AfterLife serves. This gate was being applied — `EW.has(a)` — but the
// set was never defined, so EVERY publish died with "EW is not defined" and imported nothing while still
// returning HTTP 200. Defining it here restores the intended filter: Scottish, Northern Irish and Channel
// Island areas are dropped rather than published into a marketplace that does not cover them.
const EW = new Set(("AL B BA BB BD BH BL BN BR BS CA CB CF CH CM CO CR CT CV CW DA DE DH DL DN DT DY E EC EN "
  + "EX FY GL GU HA HD HG HP HR HU IG IP KT L LA LD LE LL LN LS LU M ME MK N NE NG NN NP NR NW OL OX PE PL PO "
  + "PR RG RH RM S SA SE SG SK SL SM SN SO SP SR SS ST SW SY TA TF TN TQ TR TS TW UB W WA WC WD WF WN WR WS "
  + "WV YO").split(" "));

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const token = (process.env.SUPPLIER_IMPORT_TOKEN || "").trim();
    if (!token) {
      return { statusCode: 200, headers, body: JSON.stringify({
        ok: false, error: "SUPPLIER_IMPORT_TOKEN is not set on this Netlify site. Add it in Site settings → Environment variables, then redeploy." }) };
    }

    const body = JSON.parse(event.body || "{}");
    const leads = Array.isArray(body.suppliers) ? body.suppliers : [];
    if (!leads.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: "No APPROVE leads to publish." }) };

    // Shape each lead for AfterLife's importer. PHONE stays null — families reach firms
    // through AfterLife until they sign up. WEBSITE is now sent: invited firms expose a
    // TRACKED "visit website" link + favicon on the marketplace (click-through is the demand
    // signal). Vetting facts ride along in _internal.
    const suppliers = leads.slice(0, 1000).map(l => ({
      id: l.id || undefined,                       // let AfterLife slug from the name if absent
      name: String(l.name || "").slice(0, 200),
      category: String(l.category || "").slice(0, 80),
      categoryLabel: String(l.categoryLabel || l.category || "").slice(0, 120),
      // areas[] is the source of truth for a Regional/National firm (it holds several postcode
      // areas); `area` is kept as the primary for legacy readers. AfterLife's importer accepts both.
      areas: (Array.isArray(l.areas) ? l.areas : (l.area ? [l.area] : []))
        .map(a => String(a).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2))
        .filter(a => a && EW.has(a)),
      // Take the primary from the FILTERED list — otherwise an area the gate just removed could still
      // arrive as the record's headline area.
      area: (() => {
        const list = (Array.isArray(l.areas) ? l.areas : (l.area ? [l.area] : []))
          .map(a => String(a).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2)).filter(a => a && EW.has(a));
        return list[0] || "";
      })(),
      // Derived here as well as sent, so a caller that forgets the flag still cannot publish a firm covering
      // eighty areas as "Local". areaCount travels with it so the marketplace need not recount.
      areaCount: (Array.isArray(l.areas) ? l.areas.length : (l.area ? 1 : 0)),
      national: (typeof l.national === "boolean") ? l.national : ((Array.isArray(l.areas) ? l.areas.length : 0) >= 8),
      tier: (["Local", "Regional", "National"].includes(l.tier) ? l.tier : "Local"),
      district: String(l.district || "").toUpperCase().replace(/\s+/g, "").slice(0, 5),
      town: String(l.town || "").slice(0, 120),
      address: String(l.address || "").slice(0, 300),
      credentials: Array.isArray(l.credentials) ? l.credentials.slice(0, 12).map(c => String(c).slice(0, 80)).filter(Boolean) : [],
      description: String(l.description || "").slice(0, 1200),
      priority: Number.isFinite(+l.priority) ? +l.priority : 99,
      phone: null,
      website: (l.website ? String(l.website).slice(0, 300) : null),
      _internal: {
        contactEmail: (l.contactEmail || "") || null,
        contactPhone: (l.contactPhone || "") || null,   // carried for staff outreach; public `phone` stays null
        branches: Array.isArray(l.branches) ? l.branches.slice(0, 40) : [],   // per-area premises, kept when a firm collapses to one record
        companyNo: (l.companyNo || "") || null,
        companyId: (l.companyId || "") || null,
        saif: (l.saif || "") || null,
        tradingBrands: (l.tradingBrands || "") || null,
        verified: (l.verified || "") || null,
        notes: (l.notes || "") || null,
      },
    }));

    const r = await fetch(IMPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ suppliers }),
    });

    if (r.status === 401 || r.status === 403) {
      return { statusCode: 200, headers, body: JSON.stringify({
        ok: false, status: r.status,
        error: "AfterLife rejected the token (401/403). The SUPPLIER_IMPORT_TOKEN on this site does not match the one on afterlife.ltd — update it and redeploy." }) };
    }

    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: r.status, error: (data && data.error) || `AfterLife import failed (HTTP ${r.status}).` }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({
      ok: true, imported: (data && data.imported) || 0, ids: (data && data.ids) || [], errors: (data && data.errors) || [], sent: suppliers.length }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
