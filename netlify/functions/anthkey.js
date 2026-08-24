// Which Anthropic key is this site actually using, and what exactly does the API say about it?
// Shows only the last four characters — enough to match against the console, never enough to use.
// Exists because a "credit balance too low" error is ORGANISATION-level: topping up one workspace does
// nothing if the key in Netlify belongs to another.
const clean = k => ((k || "").replace(/[^\x21-\x7E]/g, "").trim()) || null;

exports.handler = async () => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const key = clean(process.env.ANTHROPIC_API_KEY);
  const out = { haveKey: !!key };
  if (!key) return { statusCode: 200, headers, body: JSON.stringify({ ...out, error: "ANTHROPIC_API_KEY not set" }) };
  out.keyLength = key.length;
  out.keyEndsWith = key.slice(-4);
  out.keyStartsWith = key.slice(0, 11);      // "sk-ant-api0" style prefix, not secret

  // /v1/models is a plain listing: it answers on a valid key even with no credit, so it separates
  // "bad key" from "no money".
  try {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    out.modelsStatus = r.status;
    out.keyValid = r.ok;
    if (!r.ok) out.modelsError = (await r.text()).slice(0, 300);
  } catch (e) { out.modelsError = e.message; }

  // then the cheapest possible completion, which is what actually fails when credit is gone
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 4, messages: [{ role: "user", content: "hi" }] })
    });
    out.messagesStatus = r.status;
    out.canSpend = r.ok;
    if (!r.ok) out.messagesError = (await r.text()).slice(0, 300);
    out.requestId = r.headers.get("request-id") || null;
  } catch (e) { out.messagesError = e.message; }
  return { statusCode: 200, headers, body: JSON.stringify(out) };
};
