// Postcode Prospector — AI CLASSIFIER.
// The core quality gate: Claude judges every swept business the way a human would.
// Batches results and returns keep/reject + a reason per business.
const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const apiKey = clean(process.env.ANTHROPIC_API_KEY || body.anthropicKey);
    if (!apiKey) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: "no Anthropic key" }) };
    const request = (body.request || "").slice(0, 400);
    const items = (body.items || []).slice(0, 40);
    if (!items.length) return { statusCode: 200, headers, body: JSON.stringify({ verdicts: [] }) };

    const list = items.map((it, i) =>
      `${i}. ${it.name} | types: ${(it.types || []).slice(0,4).join(",")} | web: ${it.website || "none"} | ${it.address || ""}`
    ).join("\n");

    const system = `You are a lead-qualification analyst for a UK deathcare supplier marketplace. The user is recruiting suppliers of a SPECIFIC type. You are given raw Google Places results, which are noisy: they contain adjacent-but-wrong business types, national chains, and franchises.

CRITICAL RULE: NEVER justify a verdict from the company NAME alone. Names are worthless as evidence — "Financial Planning Ltd", "Wealth Management" and "Financial Services" are used equally by IFAs, mortgage brokers, tied agents and accountants. Reasons like "independent financial planning firm" (which merely paraphrase the name) are FORBIDDEN.
Judge from EVIDENCE ONLY: the website DOMAIN (e.g. mymortgagebroker.co.uk = mortgage broker, regardless of the company name), the Google place TYPES, and the address. If there is no real evidence either way, return keep:true but type:"UNVERIFIED" and reason:"name only — needs website/FCA check". Being honest about uncertainty is REQUIRED; do not guess "IFA" from a name.
Be decisive and strict — a wrong lead costs the user more than a missed one.

Key traps you must catch:
- "Independent financial adviser" requested → REJECT mortgage brokers (Just Mortgages, "Finance Ltd", "Mortgage", "Property Finance", "Commercial Finance", sites like mymortgagebroker.co.uk), REJECT restricted/tied networks (St James's Place, NFU Mutual, Openwork, Quilter, Intrinsic, Amber River, True Potential, Sesame, Tenet appointed reps), REJECT insurance-only brokers, REJECT accountants. KEEP only genuine independent whole-of-market financial advice firms.
- "Funeral directors" requested → REJECT Co-op/Dignity/Funeral Partners branches AND their local-name subsidiaries (Francis Chappell, W H Scott, J H Kenyon are Dignity), REJECT crematoria/cemeteries/masons/florists.
- "Florists" requested → REJECT supermarkets, garden centres, DIY/craft stores (Tesco, The Range, Hobbycraft, B&M), REJECT nurseries that don't do bouquets.
- "Celebrants" requested → REJECT wedding-only celebrants, REJECT registrars.
- "Solicitors/probate" requested → REJECT firms with no private-client/probate offering, REJECT claims-management companies.
- Generally: REJECT national chains/franchises when the user wants independents; REJECT businesses whose real trade differs from what was requested.

Respond with ONLY a JSON array, no markdown, no preamble. One object per input, in order:
[{"i":0,"keep":true,"type":"IFA","reason":"whole-of-market independent adviser"},{"i":1,"keep":false,"type":"Mortgage broker","reason":"home finance only, not investment advice"}]
"type" = what the business actually is (short). "reason" = under 12 words.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: `The user is sourcing: "${request}"\n\nClassify these ${items.length} businesses:\n${list}` }]
      })
    });
    const data = await r.json();
    if (data.error) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, error: data.error.message }) };
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    const cleanTxt = text.replace(/```json|```/g, "").trim();
    let verdicts = [];
    try { verdicts = JSON.parse(cleanTxt); } catch { 
      const m = cleanTxt.match(/\[[\s\S]*\]/);
      if (m) { try { verdicts = JSON.parse(m[0]); } catch {} }
    }
    return { statusCode: 200, headers, body: JSON.stringify({ verdicts }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, error: e.message }) };
  }
};
