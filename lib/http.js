// api/lib/http.js
// Vercel Node functions biasanya udah auto-parse JSON body jadi object
// (req.body). Helper ini jaga-jaga kalau body masih berupa string/Buffer
// atau kosong, biar perilakunya sama kayak dulu di Netlify (JSON.parse(event.body || "{}")).
function parseBody(req) {
  const raw = req.body;
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  return JSON.parse(String(raw));
}

module.exports = { parseBody };
