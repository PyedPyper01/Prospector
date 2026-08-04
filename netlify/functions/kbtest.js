// Probe: can a bare (dependency-free) function use Netlify's built-in Blobs store? If yes, PP gets a free
// persistent knowledge base with zero setup for Dan (no Supabase account, no keys). If no, we fall to Supabase.
exports.handler = async () => {
  const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  try {
    const { getStore } = require("@netlify/blobs");
    const store = getStore("pp-kb");
    await store.setJSON("probe", { hello: "world", t: Date.now() });
    const got = await store.get("probe", { type: "json" });
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, roundtrip: got }) };
  } catch (e) {
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
