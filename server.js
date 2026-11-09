// Serveur Jurgenita : sert l'interface (public/), l'API JSON et les connecteurs.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
if (fs.existsSync(path.join(here, ".env"))) process.loadEnvFile(path.join(here, ".env"));

const store = await import("./src/store.js");
const sources = await import("./src/sources.js");
const google = await import("./src/connectors/google.js");
const meta = await import("./src/connectors/meta.js");
const telegram = await import("./src/connectors/telegram.js");
const LIVE = !process.env.JURGENITA_DEMO && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const brain = LIVE ? await import("./src/claude.js") : await import("./src/demo.js");

const PORT = Number(process.env.PORT || 3000);
// Pas d'authentification : on n'écoute que sur la machine locale par défaut.
const HOST = process.env.HOST || "127.0.0.1";
const GOOGLE_REDIRECT = `http://127.0.0.1:${PORT}/auth/google/callback`;
const PUBLIC_DIR = path.join(here, "public");
const STORED = new Set(["profile", "calendar", "notes", "drafts"]);
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json" };

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    // Les images envoyées pour analyse peuvent peser quelques Mo.
    if (raw.length > 20_000_000) throw fail(413, "Requête trop volumineuse");
  }
  return raw ? JSON.parse(raw) : {};
}

async function readData(name) {
  if (STORED.has(name)) return store.read(name);
  if (name === "inbox") return sources.inbox();
  if (name === "community") return sources.community();
  if (name === "agenda") return sources.agenda();
  if (name === "stats") return sources.stats();
  throw fail(404, "Données inconnues");
}

// Briefing pour Telegram, pas plus d'une fois par jour.
let lastTelegramBriefing = null;
async function sendTelegramBriefing() {
  const b = await brain.briefing();
  await telegram.send(telegram.formatBriefing(b));
  lastTelegramBriefing = new Date().toDateString();
  return b;
}

const routes = {
  "GET /api/status": () => ({
    mode: LIVE ? "live" : "demo",
    modele: LIVE ? brain.MODEL : null,
    profil: store.read("profile"),
    connexions: { ...sources.connections(), telegram: { configure: telegram.configured(), pret: telegram.ready() } },
  }),
  "POST /api/briefing": () => brain.briefing(),
  "POST /api/email/reply": (body) => brain.emailReply(body),
  "POST /api/studio": (body) => {
    if (!body.sujet?.trim()) throw fail(400, "Indiquez un sujet");
    return brain.contentStudio(body);
  },
  "POST /api/vision": (body) => {
    if (!Array.isArray(body.images) || !body.images.length) throw fail(400, "Aucune image reçue");
    return brain.visionReport(body);
  },
  "POST /api/community": () => brain.communityTriage(),
  "POST /api/community/publish": async (body) => {
    if (!meta.configured()) throw fail(400, "Meta n'est pas connecté");
    if (!body.message?.trim()) throw fail(400, "Réponse vide");
    await meta.reply(body);
    return { ok: true };
  },
  "POST /api/chat": (body) => {
    if (!body.message?.trim()) throw fail(400, "Message vide");
    return brain.chat({ conversationId: body.conversationId || randomUUID(), message: body.message });
  },
  "POST /api/chat/reset": (body) => (brain.resetConversation(body.conversationId), { ok: true }),
  "POST /api/calendar": (body) => store.append("calendar", { statut: "idée", ...body }),
  "POST /api/drafts": async (body) => {
    const draft = store.append("drafts", { ...body, cree: new Date().toISOString() });
    // Si Gmail est connecté, le brouillon d'un mail est aussi créé dans Gmail.
    if (body.canal === "email" && google.connected()) {
      await google.createDraft({ to: body.destinataire, subject: body.objet, body: body.texte, threadId: body.threadId, inReplyTo: body.messageId });
      return { ...draft, gmail: true };
    }
    return draft;
  },
  "POST /api/google/disconnect": () => (google.disconnect(), { ok: true }),
  "POST /api/telegram/briefing": async () => {
    if (!telegram.ready()) throw fail(400, "Telegram n'est pas configuré (TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID)");
    await sendTelegramBriefing();
    return { ok: true };
  },
  "PUT /api/profile": (body) => store.write("profile", { ...store.read("profile"), ...body }),
  "POST /api/reset": () => (store.reset(), { ok: true }),
};

// Connexion Google (OAuth) : /auth/google redirige vers Google, qui revient sur le callback.
const oauthStates = new Set();
async function handleAuth(req, res, url) {
  if (url.pathname === "/auth/google") {
    if (!google.configured()) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Ajoutez GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env (voir CONNEXIONS.md).");
      return;
    }
    const state = randomUUID();
    oauthStates.add(state);
    res.writeHead(302, { location: google.authUrl(GOOGLE_REDIRECT, state) }).end();
    return;
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  let message = "Gmail et Google Agenda sont connectés. Vous pouvez fermer cet onglet.";
  if (!oauthStates.delete(state)) message = "Lien de connexion expiré. Recommencez depuis Jurgenita.";
  else if (!code) message = `Connexion annulée (${url.searchParams.get("error") || "aucun code"}).`;
  else {
    try { await google.handleCallback(code, GOOGLE_REDIRECT); }
    catch (err) { message = `Échec : ${err.message}`; }
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Jurgenita</title><body style="background:#05080f;color:#e6f1ff;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><p>${message.replace(/[<>&]/g, "")}</p><p><a style="color:#4fd8ff" href="/">Retour à Jurgenita</a></p></div>`);
}

function serveStatic(req, res, url) {
  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("Introuvable");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/auth/google")) return handleAuth(req, res, url);
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url);

  try {
    const dataMatch = req.method === "GET" && url.pathname.match(/^\/api\/data\/(\w+)$/);
    if (dataMatch) return send(res, 200, await readData(dataMatch[1]));
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { erreur: "Route inconnue" });
    send(res, 200, await handler(await readBody(req)));
  } catch (err) {
    console.error(`[${req.method} ${url.pathname}]`, err);
    send(res, err.status || 500, { erreur: err.message });
  }
});

server.listen(PORT, HOST, () => {
  const c = sources.connections();
  console.log(`\n  ◉ JURGENITA en ligne — http://${HOST}:${server.address().port}`);
  console.log(LIVE ? `    Cerveau : ${brain.MODEL}` : "    Cerveau : mode démo (ajoutez ANTHROPIC_API_KEY dans .env)");
  console.log(`    Gmail : ${c.gmail.connecte ? "connecté" : c.gmail.configure ? "à connecter depuis le Profil" : "non configuré"}`);
  console.log(`    Instagram / Facebook : ${c.meta.configure ? "connecté" : "non configuré"}`);
  console.log(`    Telegram : ${telegram.ready() ? "prêt" : telegram.configured() ? "envoyez un message au bot pour obtenir TELEGRAM_CHAT_ID" : "non configuré"}\n`);
});

if (telegram.configured()) {
  telegram.listen(async (text) => {
    if (/^\/?briefing$/i.test(text)) {
      await sendTelegramBriefing();
      return "Voilà pour ce matin, Boss.";
    }
    if (text === "/start") return "Jurgenita à votre service. Écrivez « briefing » ou posez-moi une question.";
    return (await brain.chat({ conversationId: "telegram", message: text })).texte;
  });

  // Briefing automatique à l'heure de réveil du profil (heure de Paris).
  setInterval(async () => {
    if (!telegram.ready()) return;
    const now = new Date();
    const hm = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
    if (hm !== store.read("profile").heure_reveil || lastTelegramBriefing === now.toDateString()) return;
    try { await sendTelegramBriefing(); }
    catch (err) { console.error("[telegram] briefing automatique :", err.message); }
  }, 30_000);
}
