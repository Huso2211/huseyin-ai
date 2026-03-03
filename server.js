const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- PASSWORD PROTECTION ----------
const APP_PASSWORD = process.env.APP_PASSWORD || "";

// basit cookie parse
function parseCookieHeader(h = "") {
  const out = {};
  h.split(";").forEach(part => {
    const s = part.trim();
    if (!s) return;
    const i = s.indexOf("=");
    const k = i >= 0 ? s.slice(0, i) : s;
    const v = i >= 0 ? s.slice(i + 1) : "";
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function isAuthed(req) {
  if (!APP_PASSWORD) return true; // şifre ayarlanmadıysa koruma yok
  const c = parseCookieHeader(req.headers.cookie || "");
  return c.auth === "1";
}

// Login sayfası
app.get("/login", (req, res) => {
  if (isAuthed(req)) return res.redirect("/");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Giriş</title>
<style>
body{font-family:Arial;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#111;color:#fff}
.card{background:#1b1b1b;padding:18px;border-radius:14px;max-width:360px;width:92%}
input,button{width:100%;padding:12px;border-radius:10px;border:0;margin-top:10px;font-size:16px}
button{cursor:pointer}
small{opacity:.8}
</style></head>
<body>
  <div class="card">
    <h2>Hüseyin AI Giriş</h2>
    <small>Şifre girince 30 gün hatırlar.</small>
    <form method="POST" action="/login">
      <input name="password" type="password" placeholder="Şifre" required />
      <button type="submit">Giriş Yap</button>
    </form>
  </div>
</body></html>`);
});

app.post("/login", (req, res) => {
  const pass = String(req.body.password || "");
  if (!APP_PASSWORD) return res.redirect("/"); // koruma yoksa
  if (pass === APP_PASSWORD) {
    // 30 gün
    res.setHeader("Set-Cookie", `auth=1; Path=/; Max-Age=${30*24*60*60}; SameSite=Lax`);
    return res.redirect("/");
  }
  return res.redirect("/login");
});

// Koruma middleware (login ve healthz hariç)
app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();
  if (req.path === "/login" || req.path === "/healthz") return next();
  if (isAuthed(req)) return next();

  // Sayfa istekleri -> login'e yönlendir
  if (req.method === "GET") return res.redirect("/login");

  // API istekleri -> 401
  return res.status(401).json({ reply: "Giriş gerekli (şifre)." });
});
// ---------- END PASSWORD PROTECTION ----------


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
app.get("/healthz", (req, res) => res.status(200).send("ok"));

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
