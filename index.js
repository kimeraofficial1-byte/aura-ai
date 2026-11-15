// Backend opzionale per collegare un modello AI.
// Non inserire mai la chiave API nel frontend. Configurare AURA_AI_ENDPOINT
// e AURA_AI_API_KEY nell'ambiente del server quando si sceglie il provider.
import http from "node:http";

const port = Number(process.env.PORT || 8787);
const endpoint = process.env.AURA_AI_ENDPOINT;
const apiKey = process.env.AURA_AI_API_KEY;

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "http://localhost:5173");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method !== "POST" || req.url !== "/api/chat") {
    res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Not found" }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try { body = JSON.parse(raw); } catch {
    res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Invalid JSON" }));
  }
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 4000) : "";
  if (!message) {
    res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Message required" }));
  }
  if (!endpoint || !apiKey) {
    res.writeHead(503, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "AI provider not configured" }));
  }
  try {
    // Provider adapter: endpoint must accept {message} and return {reply}.
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        message,
        system: "Sei AURA, un assistente per il benessere quotidiano: empatico, professionale e non giudicante. Non fare diagnosi, non presentarti come psicologo, non prescrivere trattamenti. Aiuta con ascolto, domande aperte e strategie generali a basso rischio. Non minimizzare situazioni di pericolo. In caso di rischio immediato di autolesionismo o pericolo, invita a contattare i servizi di emergenza locali e una persona fidata. Non sostituire professionisti sanitari."
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (!upstream.ok) throw new Error(`Provider status ${upstream.status}`);
    const data = await upstream.json();
    const reply = typeof data.reply === "string" ? data.reply : "";
    if (!reply) throw new Error("Provider response missing reply");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ reply }));
  } catch (error) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "AI service unavailable" }));
  }
});
server.listen(port, "0.0.0.0", () => console.log(`AURA API listening on ${port}`));
