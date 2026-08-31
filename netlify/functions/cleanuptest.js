// Remove the ZZ test records I published into AfterLife while measuring the importer's limits.
// Deliberately narrow: it refuses any id that does not start with "zz-", so it cannot touch a real supplier
// however it is called. The AfterLife admin token stays server-side, exactly as publish.js holds it.
const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
const DELETE_URL = "https://afterlife.ltd/api/suppliers/delete";

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const token = clean(process.env.SUPPLIER_IMPORT_TOKEN);
  if (!token) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: "SUPPLIER_IMPORT_TOKEN not set" }) };
  try {
    const body = JSON.parse(event.body || "{}");
    const asked = Array.isArray(body.ids) ? body.ids : [];
    const ids = asked.filter(id => /^zz-/i.test(String(id)));      // the whole safety of this function
    const refused = asked.length - ids.length;
    if (!ids.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: "no zz- ids given", refused }) };
    const r = await fetch(DELETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ ids })
    });
    const txt = await r.text();
    let d = null; try { d = JSON.parse(txt); } catch {}
    return { statusCode: 200, headers, body: JSON.stringify({ ok: r.ok, refused, status: r.status, result: d || txt.slice(0, 200) }) };
  } catch (e) { return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: e.message }) }; }
};
