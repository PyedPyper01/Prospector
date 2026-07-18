// Postcode Prospector — WRITE-UP (marketplace description generator).
// Called at publish time for the leads the OPERATOR picked, to produce the warm,
// factual marketplace copy AfterLife shows to families. Unlike vetrank (which only
// writes copy for the strict APPROVE grade), this writes a description for EVERY
// lead it's given — the operator has already decided to list them. Site text comes
// pre-fetched from /enrich (out.siteText), so this is one Claude call, no crawling.
// Batched 25 at a time by the caller, like /vetrank and /classify.

const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;
function hostOf(url) {
  try { const u = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url); return u.hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

const SYSTEM = `You write short marketplace listings for AfterLife, a UK service that introduces INDEPENDENT deathcare and later-life firms to bereaved families. For each firm you are given its name, website domain, the category it's being listed under, review rating/count, any named credentials, and the STRIPPED TEXT OF ITS OWN WEBSITE.

Write, for each firm, a warm, plain, factual British-English description to introduce it to a grieving family:
- 2-3 sentences. Calm and reassuring, never salesy.
- Use ONLY facts present in the firm's own site text (services, faith/cultural provision, years established, chapel of rest, out-of-hours, home visits, accreditations). NEVER invent services, dates, faith provision, prices, or credentials.
- No superlatives, no "leading"/"best"/"trusted"/"award-winning" unless the site states a specific named award (then state it plainly).
- A short credentials line may be folded into the last sentence if the site names concrete ones (Chartered, STEP, NAFD, SAIF, SRA-regulated, CQC rating, years established).
- If the site text is thin or missing, write a minimal neutral 1-2 sentence description from the name + category + rating only, and do not invent anything.

Respond with ONLY a JSON array, no markdown, no preamble, one object per input firm IN ORDER:
[{"i":0,"description":"...","credentials":"Chartered, STEP"}]
credentials: a short comma-separated line of concrete credentials you actually saw ("" if none).`;

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "*" } };
  try {
    const body = JSON.parse(event.body || "{}");
    const apiKey = clean(process.env.ANTHROPIC_API_KEY || body.anthropicKey);
    const request = (body.request || "").slice(0, 400);
    const items = (body.items || []).slice(0, 25);
    if (!items.length) return { statusCode: 200, headers, body: JSON.stringify({ results: [] }) };
    if (!apiKey) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, error: "no Anthropic key" }) };

    const list = items.map((it, k) =>
      `${k}. ${it.name} | listed as: ${request || "?"} | web: ${hostOf(it.website) || "none"} | rating ${it.rating ?? "?"} (${it.reviews || 0} reviews)` +
      `${it.memberships ? ` | trade-body: ${it.memberships}` : (it.register ? ` | register: ${it.register}` : "")}${it.credentials ? ` | credentials seen: ${it.credentials}` : ""}\n` +
      `   SITE TEXT: ${(it.siteText || "").slice(0, 1800) || "(no site text — write a minimal neutral description, invent nothing)"}`
    ).join("\n\n");

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: "user", content: `Write AfterLife marketplace listings for these ${items.length} firms:\n\n${list}` }]
      })
    });
    const data = await r.json();
    if (data.error) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, error: data.error.message }) };
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").replace(/```json|```/g, "").trim();
    let parsed = [];
    try { parsed = JSON.parse(text); }
    catch { const m = text.match(/\[[\s\S]*\]/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }

    const results = (parsed || []).map(v => ({
      i: typeof v.i === "number" ? v.i : -1,
      description: String(v.description || "").slice(0, 1000),
      credentials: String(v.credentials || "").slice(0, 160),
    })).filter(v => v.i >= 0);

    return { statusCode: 200, headers, body: JSON.stringify({ results }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, error: e.message }) };
  }
};
