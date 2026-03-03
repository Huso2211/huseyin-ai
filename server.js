const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== PASSWORD PROTECTION ======
const APP_PASSWORD = process.env.APP_PASSWORD || "";

// cookie parse
function parseCookieHeader(h = "") {
  const out = {};
  h.split(";").forEach(part => {
    const [k, ...v] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(v.join("=") || "");
  });
  return out;
}

function isHttps(req) {
  // Render gibi proxy arkasında çalışınca bu header gelir
  const xfProto = req.headers["x-forwarded-proto"];
  return req.secure || xfProto === "https";
}

function setAuthCookie(req, res) {
  const secure = isHttps(req) ? " Secure;" : "";
  res.setHeader(
    "Set-Cookie",
    `auth=1; Path=/; Max-Age=${90 * 24 * 60 * 60}; HttpOnly; SameSite=Lax;${secure}`
  );
}

function clearAuthCookie(req, res) {
  const secure = isHttps(req) ? " Secure;" : "";
  res.setHeader(
    "Set-Cookie",
    `auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax;${secure}`
  );
}

function requireAuth(req, res, next) {
  // Şifre ayarlı değilse koruma kapalı
  if (!APP_PASSWORD) return next();

  const cookies = parseCookieHeader(req.headers.cookie || "");
  if (cookies.auth === "1") return next();

  // login sayfasına gönder
  return res.redirect("/login");
}

// ====== LOGIN / LOGOUT ======
app.get("/login", (req, res) => {
  res.send(`
  <!doctype html><html><head><meta charset="utf-8"><title>Giriş</title></head>
  <body style="font-family:Arial; display:flex; min-height:100vh; align-items:center; justify-content:center;">
    <form method="POST" action="/login" style="border:1px solid #ddd; padding:20px; border-radius:12px; width:320px;">
      <h2 style="margin-top:0;">Hüseyin AI - Giriş</h2>
      <input name="password" type="password" placeholder="Şifre" style="width:100%; padding:10px; margin:10px 0;">
      <button style="width:100%; padding:10px;">Giriş</button>
      <p style="color:#777; font-size:12px;">(Şifre yanlışsa tekrar sorar)</p>
    </form>
  </body></html>
  `);
});

app.post("/login", (req, res) => {
  if (!APP_PASSWORD) return res.redirect("/"); // şifre yoksa direkt geç
  const pw = String(req.body.password || "");
  if (pw === APP_PASSWORD) {
    setAuthCookie(req, res);
    return res.redirect("/");
  }
  return res.status(401).send("Şifre yanlış. <a href='/login'>Tekrar dene</a>");
});

// ✅ ÇIKIŞ (sende hata buradaydı)
app.get("/logout", (req, res) => {
  clearAuthCookie(req, res);
  res.redirect("/login");
});

// ====== STATIC (index.html) ======
app.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// örnek chat endpoint (senin mevcut chat kodun burada olabilir)
app.post("/chat", requireAuth, async (req, res) => {
  const message = String(req.body.message || "").trim().toLowerCase();
  // şimdilik basit cevap
  if (message.includes("merhaba")) return res.json({ reply: "Merhaba Hüseyin 👋" });
  if (message.includes("nasılsın")) return res.json({ reply: "İyiyim 😄 Sen nasılsın?" });
  return res.json({ reply: "Bunu şimdilik bilmiyorum ama geliştirebiliriz 🙂" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("AI çalışıyor → http://localhost:" + PORT));
