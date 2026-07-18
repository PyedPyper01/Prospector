// Postcode Prospector — AI request interpreter (Claude agent). Turns ANY natural-language
// sourcing instruction into structured rules. Falls back silently if no key configured.
exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const apiKey = ((process.env.ANTHROPIC_API_KEY || body.anthropicKey || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
    if (!apiKey) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true }) };
    const request = (body.request || "").slice(0, 1000);
    if (!request) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true }) };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 600,
        system: `You convert lead-sourcing instructions into JSON for a Google Places search tool that sweeps UK postcode districts. Respond with ONLY a JSON object, no markdown fences, no preamble. Schema:
{"search_term": string (the clean Places text query — what to search for, nothing else),
 "omit_names": string[] (ONLY specific brand names the USER EXPLICITLY typed to exclude, lowercase. Do NOT invent, expand or free-associate. Do NOT add chains/consolidators yourself — the app applies its own vetted consolidator blocklist from config. NEVER include trade bodies (SAIF, NAFD, Humanists UK, etc.) — those are INDEPENDENTS, the opposite of a chain. NEVER include generic/geographic/foreign-language words. If the user named nothing to omit, return []),
 "min_reviews": number|null, "min_rating": number|null,
 "must_have_website": boolean, "must_have_phone": boolean,
 "relevant_place_types": string[] (Google Places API type ids a RELEVANT result would carry, e.g. ["florist"] for florists, ["funeral_home"] for funeral directors, ["lawyer"] for solicitors; empty array if no clean type exists),
 "relevance_keywords": string[] (lowercase words; a result is relevant if its NAME or types contain at least one, e.g. ["florist","flower","bloom"] — used to reject supermarkets/garden centres/big-box stores that Google returns for loose matches),
 "note": string (one short line explaining your interpretation)}
Rules: keep search_term tight (2-5 words works best per district). Never put exclusions, thresholds or filler words in search_term. omit_names must contain ONLY brands the user explicitly named — never your own additions, never a trade body.`,
        messages: [{ role: "user", content: request }]
      })
    });
    const data = await r.json();
    if (data.error) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, error: data.error.message }) };
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...parsed }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, error: e.message }) };
  }
};
