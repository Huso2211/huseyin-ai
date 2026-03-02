const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());

// ---------------- RATE LIMIT ----------------
const WINDOW_MS = 60 * 1000;
const MAX_REQ = 30;
const hits = new Map();

function parseCookies(h = "") {
  const out = {};
  h.split(";").forEach(p => {
    const s = p.trim();
    if (!s) return;
    const i = s.indexOf("=");
    const k = i >= 0 ? s.slice(0, i) : s;
    const v = i >= 0 ? s.slice(i + 1) : "";
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function getSid(req, res) {
  const c = parseCookies(req.headers.cookie || "");
  let sid = c.sid;
  if (!sid || sid.length < 10) {
    sid = crypto.randomUUID();
    res.setHeader(
      "Set-Cookie",
      `sid=${encodeURIComponent(sid)}; Path=/; Max-Age=${90 * 24 * 60 * 60}; SameSite=Lax`
    );
  }
  return sid;
}

function clientKey(req, sid) {
  const ip =
    (req.headers["x-forwarded-for"] ||
     req.socket.remoteAddress ||
     "").toString().split(",")[0].trim();
  return `${ip}|${sid || "nosid"}`;
}

function rateLimit(req, res, next) {
  const sid = getSid(req, res);
  const key = clientKey(req, sid);

  const now = Date.now();
  const entry = hits.get(key) || { n: 0, start: now };
  if (now - entry.start > WINDOW_MS) { entry.n = 0; entry.start = now; }
  entry.n += 1;
  hits.set(key, entry);

  if (entry.n > MAX_REQ) {
    return res.status(429).json({ reply: "Cok hizli istek attin. 1 dakika sonra tekrar dene." });
  }

  req._sid = sid;
  next();
}

// ---------------- MEMORY ----------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function memFile(sid) {
  return path.join(DATA_DIR, `memory_${sid}.json`);
}

function loadMem(sid) {
  try {
    const f = memFile(sid);
    if (!fs.existsSync(f)) return { name: null, notes: [], history: [] };
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return { name: null, notes: [], history: [] };
  }
}

function saveMem(sid, m) {
  fs.writeFileSync(memFile(sid), JSON.stringify(m, null, 2), "utf8");
}

function addHist(sid, m, role, text) {
  m.history.push({ role, text, t: Date.now() });
  if (m.history.length > 30) m.history.shift();
  saveMem(sid, m);
}

function who(m) {
  return m.name || "kanka";
}

// ---------------- WEB SEARCH ----------------
async function webSearch(query, limit = 5) {
  const url = "https://duckduckgo.com/html/?" + new URLSearchParams({ q: query }).toString();
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await r.text();

  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < limit) {
    const title = m[2].replace(/<[^>]*>/g, "").trim();
    results.push({ title, url: m[1] });
  }
  return results;
}

// ---------------- ROUTES ----------------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.use(rateLimit);

app.get("/me", (req, res) => {
  const m = loadMem(req._sid);
  res.json({ name: m.name, notes: m.notes });
});

app.post("/set-name", (req, res) => {
  const m = loadMem(req._sid);
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ ok: false });
  m.name = name;
  saveMem(req._sid, m);
  res.json({ ok: true });
});

app.post("/add-note", (req, res) => {
  const m = loadMem(req._sid);
  const note = String(req.body.note || "").trim();
  if (!note) return res.status(400).json({ ok: false });
  m.notes.push(note);
  saveMem(req._sid, m);
  res.json({ ok: true });
});

app.post("/reset", (req, res) => {
  saveMem(req._sid, { name: null, notes: [], history: [] });
  res.json({ ok: true });
});

app.get("/export", (req, res) => {
  const m = loadMem(req._sid);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(m, null, 2));
});

app.post("/import", (req, res) => {
  saveMem(req._sid, req.body || { name: null, notes: [], history: [] });
  res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  const mem = loadMem(req._sid);
  const raw = String(req.body.message || "").trim();
  const msg = raw.toLowerCase();
  addHist(req._sid, mem, "user", raw);

  let reply = `Anlayamadim ${who(mem)}.`;

  try {
    if (msg.startsWith("ara:")) {
      const q = raw.split(":").slice(1).join(":").trim();
      const results = await webSearch(q, 5);
      reply = results.length
        ? results.map((r,i)=>`${i+1}) ${r.title}\n${r.url}`).join("\n\n")
        : "Sonuc bulunamadi.";
    } else {
      const results = await webSearch(raw, 3);
      if (results.length) {
        reply = results.map((r,i)=>`${i+1}) ${r.title}\n${r.url}`).join("\n\n");
      }
    }
  } catch {
    reply = "Hata oldu.";
  }

  addHist(req._sid, mem, "bot", reply);
  res.json({ reply });
});

// ---- START SERVER ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("AI running on port " + PORT));
