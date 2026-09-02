// Postcode Prospector — READ AND TIDY WHAT IS ALREADY PUBLISHED ON AFTERLIFE.
//
// Everything else here publishes INTO AfterLife. This reads back what is there and lets the operator fix
// it after the fact, which is the only way to deal with a company that is already on the site more than
// once: de-duplicating the grid before publishing cannot help records that went out weeks ago.
//
// It is a thin proxy over AfterLife's own admin API — the same three routes its admin console uses:
//   list   → GET  /api/suppliers/admin?page=N&pageSize=...   (every stored record, any status)
//   import → POST /api/suppliers/import                      (rewrite the surviving record)
//   delete → POST /api/suppliers/delete  { ids: [...] }       (remove the extra copies)
//
// The bearer token lives ONLY in this site's environment (SUPPLIER_IMPORT_TOKEN, already set — it is what
// publish.js uses). It is read here and sent as the Authorization header; it never reaches the browser and
// is never returned in a response.

const BASE = "https://afterlife.ltd/api/suppliers";

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };

  const token = (process.env.SUPPLIER_IMPORT_TOKEN || "").trim();
  if (!token) return { statusCode: 200, headers, body: JSON.stringify({
    ok: false, error: "SUPPLIER_IMPORT_TOKEN is not set on this Netlify site." }) };
  const AUTH = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  try {
    const body = JSON.parse(event.body || "{}");
    const action = body.action || "list";

    // Per-area record counts, straight off the index. Cheap, and it tells the caller which areas to walk.
    if (action === "facets") {
      const r = await fetch(BASE + "/admin?facets=1", { headers: AUTH });
      const txt = await r.text();
      if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: r.status, detail: txt.slice(0, 300) }) };
      let d; try { d = JSON.parse(txt); } catch { return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: "not JSON", detail: txt.slice(0, 200) }) }; }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, areas: d.areas || {} }) };
    }

    if (action === "list") {
      // ALWAYS read one AREA at a time. Asking for everything makes AfterLife scan every stored blob and
      // the function dies at its 26-second limit — which comes back as a 502, i.e. exactly like "there is
      // nothing there". An area reads through the area index instead and returns immediately. A firm
      // covering several areas comes back once per area; the caller matches on id.
      const page = Math.max(1, +body.page || 1);
      const pageSize = Math.min(2000, Math.max(1, +body.pageSize || 1000));
      const area = String(body.area || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
      if (!area) return { statusCode: 200, headers, body: JSON.stringify({ ok: false,
        error: "list needs an area — a whole-directory read times out on AfterLife. Use action:'facets' for the area list, then walk them." }) };
      const url = `${BASE}/admin?area=${area}&page=${page}&pageSize=${pageSize}` + (body.status ? `&status=${encodeURIComponent(body.status)}` : "");
      const r = await fetch(url, { headers: AUTH });
      const txt = await r.text();
      if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: r.status, detail: txt.slice(0, 300) }) };
      let d; try { d = JSON.parse(txt); } catch { return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: "AfterLife returned something that is not JSON", detail: txt.slice(0, 200) }) }; }
      // Only the fields needed to decide what is a duplicate — keeps the response small and carries no
      // contact details back into the browser beyond what identifies the firm.
      const suppliers = (d.suppliers || []).map(r0 => ({
        id: r0.id, name: r0.name, category: r0.category, categoryLabel: r0.categoryLabel,
        area: r0.area, areas: r0.areas || (r0.area ? [r0.area] : []), areaCount: r0.areaCount,
        tier: r0.tier, status: r0.status, website: r0.website || "", companyNumber: r0.companyNumber || "",
        national: !!r0.national
      }));
      return { statusCode: 200, headers, body: JSON.stringify({
        ok: true, area, page: d.page, pages: d.pages, total: d.total, count: suppliers.length, suppliers }) };
    }

    if (action === "import") {
      const suppliers = Array.isArray(body.suppliers) ? body.suppliers : [];
      if (!suppliers.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: "nothing to import" }) };
      const r = await fetch(BASE + "/import", { method: "POST", headers: AUTH, body: JSON.stringify({ suppliers }) });
      const txt = await r.text();
      let d = null; try { d = JSON.parse(txt); } catch {}
      return { statusCode: 200, headers, body: JSON.stringify({ ok: r.ok, status: r.status, result: d, detail: d ? undefined : txt.slice(0, 300) }) };
    }

    if (action === "delete") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter(Boolean).slice(0, 500);
      if (!ids.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: "no ids provided" }) };
      const r = await fetch(BASE + "/delete", { method: "POST", headers: AUTH, body: JSON.stringify({ ids }) });
      const txt = await r.text();
      let d = null; try { d = JSON.parse(txt); } catch {}
      return { statusCode: 200, headers, body: JSON.stringify({ ok: r.ok, status: r.status, result: d, detail: d ? undefined : txt.slice(0, 300) }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ error: "unknown action" }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
