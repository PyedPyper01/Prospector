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

const SYSTEM = `You write short marketplace profiles for AfterLife, a UK directory that introduces INDEPENDENT funeral and later-life firms to bereaved families. For each firm you get its name, the category it's listed under, the town/area, any credentials, and the STRIPPED TEXT OF ITS OWN WEBSITE. Write the profile using ONLY facts in that site text.

TWO TESTS every profile MUST pass:
1. The FIRM would be happy to see it published about them.
2. A BEREAVED FAMILY reading it learns something that helps them choose.

FORMAT
- 45–75 words, normally TWO sentences.
- Sentence 1 — who they are: how long established or how many generations, and the TOWNS they serve (name the actual towns; NEVER "their local area").
- Sentence 2 — what they actually offer: SPECIFIC services and facilities.
- Plain, warm British English for a grieving family. No marketing hype, no superlatives (leading / best / trusted / award-winning) unless the site names a specific award — then state it plainly.

LEAD WITH WHAT IS DISTINCTIVE about this firm, not with the category. Be concrete:
- Services: religious and non-religious funerals, direct cremation, woodland/green burial, repatriation, prepaid funeral plans, forward planning.
- Facilities: chapels of rest (say how many / where if stated), own fleet, home visits for arrangements, dedicated memorials service, lady and gentleman funeral directors.
- Heritage in the firm's OWN terms: "sixth-generation", "over 160 years", "more than 30 years".
- Availability plainly: "24 hours a day, seven days a week", "any time, day or night".

PRIORITY when the site offers more than 75 words of material:
heritage/generations → towns served → 24-hour availability → distinctive services (woodland burial, repatriation, direct cremation, prepaid plans) → facilities (chapels of rest, own fleet, home visits) → anything genuinely unusual about the firm.

HARD RULES
- Every fact must come from the firm's own website. No invention, no embellishment, no guessed dates, faiths, prices or services.
- NEVER write a sentence whose only content is category, area or accreditation. BANNED, e.g.: "X is an independent funeral director serving their local community, and is a member of SAIF and NAFD." Those badges are already shown as chips above your text — repeating them is worthless.
- If the site text yields NOTHING beyond name, category, area and accreditations, output the description as exactly "NO_CONTENT" and nothing else. A blank profile is better than filler.
- For NON-funeral categories (celebrants, florists, memorial masons, solicitors, etc.) apply the SAME two tests and shape: lead with what's distinctive, name the specific services and the towns served, and use "NO_CONTENT" if the site is thin.

GOLD-STANDARD EXAMPLES — match this level, specificity and shape:
- "Hunnaball of Colchester is available 24 hours a day, seven days a week, and offers a broad range of funeral services including religious and non-religious funerals, direct cremations, woodland burial, and repatriation. They have chapels of rest, a dedicated memorials service, and a support team including both lady and gentleman funeral directors."
- "Lesley Barlow & Family Clacton Funeral Service has been providing funeral services to families in Clacton-on-Sea and the surrounding areas for more than 30 years. They are available at any time, day or night, to assist following a death, and offer forward planning for those who wish to arrange their own funeral wishes in advance."
- "P.G. Oxley Funeral Directors is a sixth-generation family business serving Walton-on-the-Naze, Frinton-on-Sea, Clacton-on-Sea, and surrounding areas, established for over 160 years. They offer 24-hour availability, private chapels of rest at three locations, home visits for arrangements, and a full range of services including woodland burials, repatriation, and prepaid funeral plans."

Respond with ONLY a JSON array, no markdown, no preamble, one object per input firm IN ORDER:
[{"i":0,"description":"...","credentials":"..."}]
- description: the 45–75 word profile, OR exactly "NO_CONTENT" if the site yields nothing beyond name/category/area/accreditation.
- credentials: a short comma-separated line of concrete credentials you actually saw in the site text ("" if none). Do NOT repeat credentials inside the description.`;

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
      `${k}. ${it.name} | listed as: ${request || "?"} | web: ${hostOf(it.website) || "none"}` +
      `${it.memberships ? ` | trade-body: ${it.memberships}` : (it.register ? ` | register: ${it.register}` : "")}${it.credentials ? ` | credentials seen: ${it.credentials}` : ""}\n` +
      `   SITE TEXT: ${(it.siteText || "").slice(0, 1800) || "(no site text — output NO_CONTENT for this firm; invent nothing)"}`
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

    const results = (parsed || []).map(v => {
      const d = String(v.description || "").trim();
      return {
        i: typeof v.i === "number" ? v.i : -1,
        // NO_CONTENT → blank: a thin site gets no filler profile, just an empty description.
        description: /^NO_?CONTENT\.?$/i.test(d) ? "" : d.slice(0, 1000),
        credentials: String(v.credentials || "").slice(0, 160),
      };
    }).filter(v => v.i >= 0);

    return { statusCode: 200, headers, body: JSON.stringify({ results }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, error: e.message }) };
  }
};
