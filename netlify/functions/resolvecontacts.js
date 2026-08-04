// Resolve WEBSITE (+ phone + email) for a LIST of already-known firms via Claude web search — cheap batch,
// one call. Companies House gives names + postcodes but no website; this fills them in BEFORE the operator
// picks, so they can actually see what they're keeping. Haiku + web search (~10–20p per batch of ~10 firms),
// which is a fraction of paid Google Place Details. Dependency-free; uses ANTHROPIC_API_KEY.

const API = "https://api.anthropic.com/v1/messages";
const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;

function extractJson(text) {
  const m = String(text || "").match(/\[[\s\S]*?\]/g);
  if (m) for (let i = m.length - 1; i >= 0; i--) { try { const v = JSON.parse(m[i]); if (Array.isArray(v)) return v; } catch (e) {} }
  const a = String(text).indexOf("["), b = String(text).lastIndexOf("]");
  if (a >= 0 && b > a) { try { const v = JSON.parse(text.slice(a, b + 1)); if (Array.isArray(v)) return v; } catch (e) {} }
  return null;
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const key = clean(process.env.ANTHROPIC_API_KEY || body.anthropicKey);
    if (!key) return { statusCode: 200, headers, body: JSON.stringify({ error: "no Anthropic key" }) };
    const area = String(body.area || "").trim().toUpperCase();
    const firms = (Array.isArray(body.firms) ? body.firms : []).slice(0, 12).map(f => ({ name: String(f.name || "").trim(), postcode: String(f.postcode || f.district || "").trim() })).filter(f => f.name);
    const model = body.model || "claude-haiku-4-5";
    const wsType = /haiku|sonnet-4-6|opus-4-5/.test(model) ? "web_search_20250305" : "web_search_20260209";
    if (!firms.length) return { statusCode: 200, headers, body: JSON.stringify({ error: "no firms" }) };

    const list = firms.map((f, i) => `${i + 1}. ${f.name}${f.postcode ? ` (${f.postcode})` : ""}`).join("\n");
    const prompt =
`These are real UK businesses in the "${area}" postcode area. For EACH one, find its official website (and, if easy, a phone number and a contact email). Use web_search — a search like the firm's name + town usually lands its own site or a listing that shows it.

${list}

Rules:
- Return the firm's OWN website (its real company site), not a directory/aggregator/Facebook page. If you genuinely can't find a site, leave website as "".
- Match each result to the firm by name. Keep the exact names as given.

Your entire final message must be ONLY a JSON array — no prose — one element per firm, in the same order:
[{"name":"<exact name>","website":"https://… or empty","phone":"… or empty","email":"… or empty"}]`;

    let messages = [{ role: "user", content: prompt }];
    let out = null, inTok = 0, outTok = 0, searches = 0, stop = "";
    for (let hop = 0; hop < 3; hop++) {
      const r = await fetch(API, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 3600, tools: [{ type: wsType, name: "web_search", max_uses: Math.min(firms.length + 2, 8), user_location: { type: "approximate", country: "GB" } }], messages })
      });
      const d = await r.json().catch(() => ({}));
      if (d.error) return { statusCode: 200, headers, body: JSON.stringify({ error: d.error.message || "api error", model }) };
      const u = d.usage || {};
      inTok += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      outTok += (u.output_tokens || 0);
      if (u.server_tool_use && typeof u.server_tool_use.web_search_requests === "number") searches += u.server_tool_use.web_search_requests;
      else (d.content || []).forEach(b => { if (b.type === "server_tool_use" && b.name === "web_search") searches++; });
      stop = d.stop_reason;
      if (d.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: d.content }); continue; }
      out = extractJson((d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n"));
      break;
    }
    const price = ({ "claude-haiku-4-5": [1, 5], "claude-sonnet-5": [3, 15] })[model] || [1, 5];
    const costUsd = inTok / 1e6 * price[0] + outTok / 1e6 * price[1] + searches / 1000 * 10;
    const got = (out || []).filter(x => x && x.website);
    return { statusCode: 200, headers, body: JSON.stringify({ area, asked: firms.length, resolved: got.length, results: out || [], searches, stop, costUsd: +costUsd.toFixed(4) }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message }) };
  }
};
