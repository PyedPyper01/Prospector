// Supabase knowledge base — persistent supplier store. Read/write via the PostgREST REST API using the
// service_role key, held only as a Netlify env var (SUPABASE_KEY). Actions:
//   test   — verify the connection + row count
//   upsert — insert/update supplier rows (dedupe on name+area via the unique constraint → never a duplicate)
//   check  — which firms are already stored (for suppression: don't re-source / re-pay)
//   get    — pull stored suppliers by trade/area
// Dependency-free (native fetch).

const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  const base = clean(process.env.SUPABASE_URL);
  const key = clean(process.env.SUPABASE_KEY);
  if (!base || !key) return { statusCode: 200, headers, body: JSON.stringify({ error: "SUPABASE_URL / SUPABASE_KEY not set in Netlify env", haveUrl: !!base, haveKey: !!key }) };
  const REST = base.replace(/\/$/, "") + "/rest/v1/suppliers";
  const H = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
  const q = (k, v) => v ? `&${k}=eq.${encodeURIComponent(v)}` : "";

  try {
    const body = JSON.parse(event.body || "{}");
    const action = body.action || "test";

    if (action === "test") {
      const r = await fetch(REST + "?select=id&limit=1", { headers: { ...H, Prefer: "count=exact" } });
      const txt = await r.text();
      if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: r.status, detail: txt.slice(0, 400) }) };
      const total = (r.headers.get("content-range") || "").split("/")[1] || "?";
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, rowsInTable: total }) };
    }

    if (action === "upsert") {
      const rows = (Array.isArray(body.rows) ? body.rows : []).map(r => ({
        name: String(r.name || "").slice(0, 300), trade: r.trade || null, category: r.category || null,
        area: (r.area || "").toUpperCase() || null, district: r.district || null, postcode: r.postcode || null, address: r.address || null,
        website: r.website || null, phone: r.phone || null, email: r.email || null, company_number: r.company_number || r.companyNumber || null,
        source: r.source || null, independence: r.independence || null, status: r.status || "new", description: r.description || null,
        source_list: r.source_list || r.sourceList || null, last_verified: r.last_verified || null, notes: r.notes || null
      })).filter(r => r.name && r.area);
      if (!rows.length) return { statusCode: 200, headers, body: JSON.stringify({ error: "no valid rows (each needs name + area)" }) };
      const r = await fetch(REST + "?on_conflict=name,area", { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
      if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: r.status, detail: (await r.text()).slice(0, 400) }) };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, upserted: rows.length }) };
    }

    if (action === "patch") {
      // Update ONLY the fields supplied, matched on name+area. `upsert` maps every column and writes null for
      // anything absent, so using it to add an email would silently blank the website and phone on that row.
      // PostgREST PATCH touches only the keys sent, which is what enrichment needs.
      const rows = Array.isArray(body.rows) ? body.rows : [];
      let done = 0; const failed = [];
      for (const r of rows) {
        if (!r || !r.name || !r.area) continue;
        const { name, area, ...fields } = r;
        if (!Object.keys(fields).length) continue;
        const u = REST + `?name=eq.${encodeURIComponent(name)}&area=eq.${encodeURIComponent(String(area).toUpperCase())}`;
        const p = await fetch(u, { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(fields) });
        p.ok ? done++ : failed.push(name);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: failed.length === 0, patched: done, failed: failed.slice(0, 10) }) };
    }

    if (action === "merge") {
      // Bulk partial update: ONE request for the whole batch, touching only the columns supplied.
      // `patch` loops row by row server-side — 100 rows meant 100 database round trips inside a single
      // function call, 18.8s against a 26s limit, and it was the reason a national sweep crawled.
      // `upsert` is fast but maps every column and writes null for anything absent, which would blank
      // fields. Passing through only the provided keys gives ON CONFLICT DO UPDATE on those columns alone.
      const rows = (Array.isArray(body.rows) ? body.rows : [])
        .filter(r => r && r.name && r.area)
        .map(r => { const o = { ...r }; o.area = String(o.area).toUpperCase(); return o; });
      if (!rows.length) return { statusCode: 200, headers, body: JSON.stringify({ error: "no valid rows" }) };
      // PostgREST takes its column list from the FIRST row of a bulk insert, so a batch whose rows carry
      // different fields silently drops the extras — a batch mixing {postcode} and {trade} wrote no
      // postcodes at all and reported success. Group by field-set and send one request per shape.
      const groups = new Map();
      for (const r of rows) {
        const k = Object.keys(r).sort().join(",");
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      let merged = 0; const failed = [];
      for (const batch of groups.values()) {
        const r = await fetch(REST + "?on_conflict=name,area", {
          method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(batch) });
        r.ok ? merged += batch.length : failed.push({ status: r.status, detail: (await r.text()).slice(0, 160) });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: !failed.length, merged, shapes: groups.size, failed }) };
    }

    if (action === "check") {
      const r = await fetch(REST + `?select=name,area,website,status${q("trade", body.trade)}${q("area", (body.area || "").toUpperCase())}&limit=20000`, { headers: H });
      if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: r.status, detail: (await r.text()).slice(0, 300) }) };
      const data = await r.json();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, count: data.length, existing: data }) };
    }

    if (action === "delete") {
      // Delete by NAME+AREA as well as by source. Without this there was no way to remove a single row, so a
      // firm entered under two spellings ("Dillys" and "Dillys Bespoke Florist") stayed duplicated forever —
      // the unique constraint is on name+area, so a variant spelling is a different row by definition.
      if (Array.isArray(body.rows) && body.rows.length) {
        let gone = 0, failed = [];
        for (const row of body.rows) {
          if (!row || !row.name || !row.area) continue;
          const u = REST + `?name=eq.${encodeURIComponent(row.name)}&area=eq.${encodeURIComponent(String(row.area).toUpperCase())}`;
          const d = await fetch(u, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
          d.ok ? gone++ : failed.push(row.name);
        }
        return { statusCode: 200, headers, body: JSON.stringify({ ok: failed.length === 0, deleted: gone, failed }) };
      }
      // Delete a whole trade in one statement. Doing it row by row means one HTTP round trip each, which
      // blows the function's execution budget long before a thousand rows are gone.
      if (body.trade) {
        const r = await fetch(REST + `?trade=eq.${encodeURIComponent(body.trade)}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: r.ok, status: r.status, deletedTrade: body.trade }) };
      }
      if (!body.source) return { statusCode: 200, headers, body: JSON.stringify({ error: "delete needs a source, a trade, or rows[] of {name, area}" }) };
      const r = await fetch(REST + `?source=eq.${encodeURIComponent(body.source)}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: r.ok, status: r.status }) };
    }

    if (action === "get") {
      // PostgREST caps a single response (default 1000 rows), which silently truncated big trades. Page with
      // Range headers until a short page comes back, so the caller always gets the FULL set.
      //
      // `offset` lets a caller walk the whole table in slices. Netlify caps a function response at 6MB, so
      // "give me everything" in one call fails for the larger trades — a backup has to page through instead.
      const want = Math.min(+body.limit || 20000, 50000);
      const skip = Math.max(0, +body.offset || 0);
      const base = REST + `?select=*${q("trade", body.trade)}${q("area", (body.area || "").toUpperCase())}&order=id`;
      const all = []; const STEP = 1000;
      for (let from = 0; from < want; from += STEP) {
        const to = Math.min(from + STEP - 1, want - 1);
        const r = await fetch(base, { headers: { ...H, Range: `${skip + from}-${skip + to}`, "Range-Unit": "items" } });
        if (!r.ok) { if (!all.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: r.status }) }; break; }
        const chunk = await r.json();
        all.push(...chunk);
        if (chunk.length < STEP) break;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, count: all.length, offset: skip, results: all }) };
    }

    if (action === "stats") {
      // What is actually in the store, by trade and by area. Pulls only two short columns so the whole table
      // fits comfortably in one response, then counts here — PostgREST has no GROUP BY without a stored view.
      const all = []; const STEP = 1000;
      for (let from = 0; from < 60000; from += STEP) {
        const r = await fetch(REST + "?select=trade,area&order=id",
          { headers: { ...H, Range: `${from}-${from + STEP - 1}`, "Range-Unit": "items" } });
        if (!r.ok) break;
        const chunk = await r.json();
        all.push(...chunk);
        if (chunk.length < STEP) break;
      }
      const byTrade = {}, byArea = {};
      for (const r of all) {
        const t = r.trade || "(no trade)"; const a = r.area || "(no area)";
        byTrade[t] = (byTrade[t] || 0) + 1;
        byArea[a] = (byArea[a] || 0) + 1;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, total: all.length, trades: Object.keys(byTrade).length, byTrade, byArea }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ error: "unknown action" }) };
  } catch (e) { return { statusCode: 200, headers, body: JSON.stringify({ error: e.message }) }; }
};
