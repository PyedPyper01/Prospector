// one-off: ask AfterLife's admin endpoint what is actually in the store, using the token
// already held on the Prospector site so the value never appears here
exports.handler = async () => {
  const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const tok = (process.env.SUPPLIER_IMPORT_TOKEN || "").trim();
  if (!tok) return { statusCode: 200, headers: H, body: JSON.stringify({ error: "no token" }) };
  const out = {};
  try {
    const f = await fetch("https://afterlife.ltd/api/suppliers/admin?facets=1", { headers: { Authorization: "Bearer " + tok } });
    out.facetsStatus = f.status;
    out.facets = f.ok ? await f.json() : (await f.text()).slice(0, 200);
  } catch (e) { out.facetsError = e.message; }
  try {
    const r = await fetch("https://afterlife.ltd/api/suppliers/admin?status=invited&area=CO", { headers: { Authorization: "Bearer " + tok } });
    const d = await r.json();
    out.CO_records = (d.suppliers || d.results || []).map(x => ({ id: x.id, name: x.name, areas: x.areas, area: x.area, cat: x.categoryLabel }));
  } catch (e) { out.CO_recordsError = e.message; }
  for (const st of ["pending", "invited", "partner"]) {
    try {
      const r = await fetch(`https://afterlife.ltd/api/suppliers/admin?status=${st}&area=CO`, { headers: { Authorization: "Bearer " + tok } });
      const d = r.ok ? await r.json() : null;
      out["CO_" + st] = d ? (d.count ?? (d.suppliers || []).length) : `HTTP ${r.status}`;
    } catch (e) { out["CO_" + st] = e.message; }
  }
  return { statusCode: 200, headers: H, body: JSON.stringify(out) };
};
