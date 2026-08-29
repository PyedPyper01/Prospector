// Postcode Prospector — "Source with Claude": discover local INDEPENDENT suppliers via Claude web search.
// Replaces the expensive Google Places discovery. Claude searches the web, VERIFIES each firm is genuinely
// based in the target UK postcode area (not overseas, not a neighbouring area), drops chains / franchises /
// consolidators / appointed-representatives, and returns firms WITH their own website. One AREA per call
// (the frontend loops areas). Cost = Anthropic tokens + web-search ($10/1,000 searches) — a small fraction
// of Google Places. The function reports its own token/search count + a cost estimate so nothing is guessed.
// Dependency-free (native fetch). Uses the ANTHROPIC_API_KEY env var (same key vetrank/interpret use).

const API = "https://api.anthropic.com/v1/messages";
const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;

function extractJson(text) {
  const m = String(text || "").match(/\[[\s\S]*?\]/g);
  if (!m) return null;
  for (let i = m.length - 1; i >= 0; i--) { try { const v = JSON.parse(m[i]); if (Array.isArray(v)) return v; } catch (e) {} }
  // last resort: greedy from first [ to last ]
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a >= 0 && b > a) { try { const v = JSON.parse(text.slice(a, b + 1)); if (Array.isArray(v)) return v; } catch (e) {} }
  return null;
}

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const key = clean(process.env.ANTHROPIC_API_KEY || body.anthropicKey);
    if (!key) return { statusCode: 200, headers, body: JSON.stringify({ error: "no Anthropic key (set ANTHROPIC_API_KEY env var)" }) };
    const trade = String(body.trade || "").trim();
    const area = String(body.area || "").trim().toUpperCase();
    const town = String(body.town || "").trim();
    const n = Math.min(Math.max(parseInt(body.n || "10", 10), 1), 20);
    // Netlify kills any function that runs past ~26s. Only Haiku's fast inference fits web-search + reasoning
    // inside that window (Sonnet/Opus reliably 504). So Haiku is the default; a caller may override for a
    // background/batch context that isn't bound by the gateway timeout.
    const model = body.model || "claude-haiku-4-5";
    const maxUses = Math.min(Math.max(parseInt(body.maxUses || "4", 10), 1), 8);
    const maxTokens = Math.min(Math.max(parseInt(body.maxTokens || "3600", 10), 800), 6000);
    if (!trade || !area) return { statusCode: 200, headers, body: JSON.stringify({ error: "need trade + area" }) };

    // web_search_20260209 (dynamic filtering) needs Opus 4.6+/Sonnet 5/Sonnet 4.6; Haiku uses the basic variant.
    const wsType = /haiku|sonnet-4-6|opus-4-5/.test(model) ? "web_search_20250305" : "web_search_20260209";

    const prompt =
`Find up to ${n} INDEPENDENT ${trade} businesses that are physically based in the "${area}" UK postcode area${town ? ` (around ${town})` : ""}.

Hard rules — apply strictly:
- UNITED KINGDOM only. The firm's OWN registered/office address postcode must start with "${area}" (i.e. ${area}1, ${area}2, …). Reject anything overseas, and reject firms whose office is actually in a different UK postcode area even if they say they "serve" this area.
- INDEPENDENT only. Reject national chains, franchises and consolidators. Reject a firm that trades under a RESTRICTED national brand (St James's Place Partner Practice, NFU Mutual agent) or is a tied agent selling one provider's products. Do NOT reject a firm merely for being an Appointed Representative: for advice firms that is usually just how a small independent gets FCA authorisation, and for funeral directors it is required in order to sell pre-paid plans. Independence is about OWNERSHIP and whether the advice is whole-of-market — not about the AR label.
- Must have its OWN website (a real firm site, not just a directory listing, Facebook page, or an aggregator profile).

Use web_search (at most ${maxUses} searches) to find candidates and verify their location. A single search like "${trade} ${town} ${area}" typically returns many firms at once — mine each results page for multiple firms rather than one search per firm. After your searches, STOP searching and write the answer.

Your entire final message must be ONLY the JSON array — no explanation, no preamble, no "Based on my search". Start it with [ and end with ]. Each element is:
{"name":"...","website":"https://...","postcode":"${area}1 2AB (best known)","town":"...","independent":true,"notes":"one line: why it's independent / any chain risk"}
Return fewer than ${n} if that's all you can genuinely verify. Return [] if none.`;

    let messages = [{ role: "user", content: prompt }];
    let out = null, inTok = 0, outTok = 0, searches = 0, stop = "";
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetch(API, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model, max_tokens: maxTokens,
          tools: [{ type: wsType, name: "web_search", max_uses: maxUses, user_location: { type: "approximate", country: "GB" } }],
          messages
        })
      });
      const d = await r.json().catch(() => ({}));
      if (d.error) return { statusCode: 200, headers, body: JSON.stringify({ error: (d.error.message || "api error"), model, wsType }) };
      const u = d.usage || {};
      inTok += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      outTok += (u.output_tokens || 0);
      if (typeof (u.server_tool_use && u.server_tool_use.web_search_requests) === "number") searches += u.server_tool_use.web_search_requests;
      else (d.content || []).forEach(b => { if (b.type === "server_tool_use" && b.name === "web_search") searches++; });
      stop = d.stop_reason;
      if (d.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: d.content }); continue; }
      const text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      out = extractJson(text);
      break;
    }
    const price = ({ "claude-haiku-4-5": [1, 5], "claude-sonnet-5": [3, 15], "claude-opus-4-8": [5, 25] })[model] || [3, 15];
    const costUsd = inTok / 1e6 * price[0] + outTok / 1e6 * price[1] + searches / 1000 * 10;
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ area, trade, model, count: (out || []).length, results: out || [], inputTokens: inTok, outputTokens: outTok, searches, stop, costUsd: +costUsd.toFixed(4) })
    };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message }) };
  }
};
