// Postcode Prospector — AGENT SOURCE ROUTER.
// There are ~45 supplier categories; hand-configuring a source list for each is impractical and
// goes stale. So for any category the operator hasn't explicitly configured, Claude decides which
// of the WIRED source connectors fit that category and in what priority (trade bodies / registers
// first, commercial directories next, Google last), and may also NAME unwired directories worth
// building. The caller caches the decision per category so Claude is asked only once.
//
// Claude picks ONLY from the wired connectors below for the actionable `sources` list; anything
// else it thinks of goes in `suggested` (logged, not fetched). Falls back gracefully with no key.

// The connectors that actually have a fetcher today, with what each covers, so Claude can match.
const CONNECTORS = [
  { id: "saif",         covers: "SAIF — trade body of INDEPENDENT funeral directors (funeral directors only)" },
  { id: "nafd",         covers: "NAFD — National Association of Funeral Directors register (funeral directors only)" },
  { id: "funeralguide", covers: "Funeral Guide — funeral director directory with reviews (funeral directors only)" },
  { id: "localfuneral", covers: "localfuneral.co.uk — funeral director directory (funeral directors only)" },
  { id: "cqc",          covers: "CQC — Care Quality Commission register of regulated care providers: care homes, nursing homes, home care / domiciliary care, supported living (care only)" },
  { id: "vouchedfor",   covers: "VouchedFor — directory of financial advisers/IFAs (also some solicitors & accountants), with reviews & qualifications; distinguishes IFA vs restricted vs mortgage" },
  { id: "rics",         covers: "RICS Find a Surveyor — RICS-regulated chartered surveyors, valuers, building surveyors (surveyors/valuers only)" },
  { id: "google",       covers: "Google Places — universal proximity search; works for ANY category. Always the last-resort catch-all." }
];
// Connectors people ask for that are NOT usable as area listers — so Claude knows to suggest, not use them.
const NON_LISTERS = "fca (FCA register is a per-firm permission VERIFIER, no geographic search — used in a separate verify pass, never as a sweep source); sra & step (Find-a-Solicitor and the STEP directory are bot-walled — not fetchable).";

const SYSTEM = `You route a UK "deathcare & later-life" supplier-sourcing tool to the right data sources for a category. Given a supplier CATEGORY and a fixed list of available source connectors, choose which connectors to sweep and IN WHAT ORDER.

Rules:
- Choose ONLY from the provided connector ids for the "sources" array. Do not invent ids there.
- Order by authority: trade-body / statutory REGISTER connectors first, then commercial directories, then "google" ALWAYS LAST as the catch-all.
- Include "google" in almost every list (it is the universal fallback). If no specialist connector fits the category, "sources" is just ["google"].
- Only include a specialist connector if it genuinely covers this category (e.g. do NOT use funeral connectors for florists, or rics for solicitors).
- Separately, in "suggested", you MAY name real UK trade bodies / registers / directories that WOULD suit this category but are not in the connector list (e.g. for "will writers": Institute of Professional Willwriters, Society of Will Writers; for "memorial masons": NAMM National Association of Memorial Masons; for "celebrants": Humanists UK, Association of Independent Celebrants). These are build suggestions only — free text, 0-4 items.
- "note": one short line explaining the choice.

Respond with ONLY a JSON object, no markdown:
{"sources":["...","google"],"suggested":["..."],"note":"..."}`;

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const apiKey = ((process.env.ANTHROPIC_API_KEY || body.anthropicKey || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
    const category = (body.category || "").toString().slice(0, 120).trim();
    if (!category) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, sources: ["google"], error: "no category" }) };
    if (!apiKey) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, sources: ["google"], error: "no Anthropic key — defaulting to Google" }) };

    const connectorList = CONNECTORS.map(c => `- ${c.id}: ${c.covers}`).join("\n");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: `CATEGORY: "${category}"\n\nAvailable connectors:\n${connectorList}\n\nNot usable as listers (suggest only, never in sources): ${NON_LISTERS}` }]
      })
    });
    const data = await r.json();
    if (data.error) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, sources: ["google"], error: data.error.message }) };
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").replace(/```json|```/g, "").trim();
    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
    if (!parsed) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, sources: ["google"], error: "unparseable agent reply" }) };

    // Sanitise: keep only real connector ids, force google present and last, cap length.
    const valid = new Set(CONNECTORS.map(c => c.id));
    let sources = (Array.isArray(parsed.sources) ? parsed.sources : []).map(s => String(s).toLowerCase().trim()).filter(s => valid.has(s));
    sources = [...new Set(sources.filter(s => s !== "google"))];
    sources.push("google");
    const suggested = (Array.isArray(parsed.suggested) ? parsed.suggested : []).map(s => String(s).slice(0, 80)).filter(Boolean).slice(0, 4);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, category, sources, suggested, note: String(parsed.note || "").slice(0, 200) }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, sources: ["google"], error: e.message }) };
  }
};
