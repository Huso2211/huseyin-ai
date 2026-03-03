const express = require("express");
const path = require("path");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== PASSWORD PROTECTION ======
const APP_PASSWORD = process.env.APP_PASSWORD || "";

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
  const xfProto = req.headers["x-forwarded-proto"];
  return req.secure || xfProto === "https";
}

function setAuthCookie(req, res) {
  const secure = isHttps(req) ? " Secure;" : "";
  res.setHeader(
    "Set-Cookie",
    `auth=1; Path=/; Max-Age=${30 * 24 * 60 * 60}; HttpOnly; SameSite=Lax;${secure}`
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
  if (!APP_PASSWORD) return next();
  const cookies = parseCookieHeader(req.headers.cookie || "");
  if (cookies.auth === "1") return next();
  return res.redirect("/login");
}

// ====== LOGIN / LOGOUT ======
app.get("/login", (req, res) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Giriş</title></head>
  <body style="font-family:Arial; display:flex; min-height:100vh; align-items:center; justify-content:center; background:#111; color:#fff;">
    <form method="POST" action="/login" style="border:1px solid #333; padding:20px; border-radius:12px; width:320px; background:#1b1b1b;">
      <h2 style="margin-top:0;">Hüseyin AI - Giriş</h2>
      <input name="password" type="password" placeholder="Şifre" style="width:100%; padding:10px; margin:10px 0; border-radius:10px; border:0;">
      <button style="width:100%; padding:10px; border-radius:10px; border:0; cursor:pointer;">Giriş</button>
      <p style="opacity:.8; font-size:12px;">Şifre doğruysa 30 gün hatırlar.</p>
    </form>
  </body></html>`);
});

app.post("/login", (req, res) => {
  if (!APP_PASSWORD) return res.redirect("/");
  const pw = String(req.body.password || "");
  if (pw === APP_PASSWORD) {
    setAuthCookie(req, res);
    return res.redirect("/");
  }
  return res.status(401).send("Şifre yanlış. <a href='/login'>Tekrar dene</a>");
});

app.get("/logout", (req, res) => {
  clearAuthCookie(req, res);
  res.redirect("/login");
});

// ====== PAGES ======
app.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ====== OPENAI CHAT ======
app.post("/chat", requireAuth, async (req, res) => {
  const message = String((req.body && req.body.message) || "").trim();

  if (!process.env.OPENAI_API_KEY) {
    return res.json({ reply: "OPENAI_API_KEY yok. Render > Environment Variables eklemelisin." });
  }

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Sen Hüseyin'in yardımcı AI asistanısın. Kısa ve net cevap ver." },
          { role: "user", content: message }
        ]
      })
    });

    const data = await r.json();

    // Hata varsa ekrana bas (sadece log)
    if (!r.ok) {
      console.error("OPENAI ERROR:", r.status, data);
      return res.json({ reply: "OpenAI hatası: " + r.status });
    }

    const reply = data?.choices?.[0]?.message?.content?.trim() || "Cevap alınamadı.";
    return res.json({ reply });

  } catch (e) {
    console.error("FETCH ERROR:", e);
    return res.json({ reply: "Bağlantı hatası oluştu." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("AI running on port " + PORT));
