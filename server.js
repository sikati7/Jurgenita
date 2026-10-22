// Serveur Jurgenita : sert l'interface (public/) et l'API JSON.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
if (fs.existsSync(path.join(here, ".env"))) process.loadEnvFile(path.join(here, ".env"));

const store = await import("./src/store.js");
const LIVE = !process.env.JURGENITA_DEMO && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const brain = LIVE ? await import("./src/claude.js") : await import("./src/demo.js");

const PORT = Number(process.env.PORT || 3000);
// Pas d'authentification : on n'écoute que sur la machine locale par défaut.
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(here, "public");
const READABLE = new Set(["profile", "inbox", "community", "agenda", "stats", "calendar", "notes", "drafts"]);
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json" };

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("Requête trop volumineuse");
  }
  return raw ? JSON.parse(raw) : {};
}

const routes = {
  "GET /api/status": () => ({
    mode: LIVE ? "live" : "demo",
    modele: LIVE ? brain.MODEL : null,
    profil: store.read("profile"),
  }),
  "POST /api/briefing": () => brain.briefing(),
  "POST /api/email/reply": (body) => brain.emailReply(body),
  "POST /api/studio": (body) => {
    if (!body.sujet?.trim()) throw Object.assign(new Error("Indiquez un sujet"), { status: 400 });
    return brain.contentStudio(body);
  },
  "POST /api/community": () => brain.communityTriage(),
  "POST /api/chat": (body) => {
    if (!body.message?.trim()) throw Object.assign(new Error("Message vide"), { status: 400 });
    return brain.chat({ conversationId: body.conversationId || randomUUID(), message: body.message });
  },
  "POST /api/chat/reset": (body) => (brain.resetConversation(body.conversationId), { ok: true }),
  "POST /api/calendar": (body) => store.append("calendar", { statut: "idée", ...body }),
  "POST /api/drafts": (body) => store.append("drafts", { ...body, cree: new Date().toISOString() }),
  "PUT /api/profile": (body) => store.write("profile", { ...store.read("profile"), ...body }),
  "POST /api/reset": () => (store.reset(), { ok: true }),
};

function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("Introuvable");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  if (!pathname.startsWith("/api/")) return serveStatic(req, res);

  const dataMatch = req.method === "GET" && pathname.match(/^\/api\/data\/(\w+)$/);
  try {
    if (dataMatch) {
      if (!READABLE.has(dataMatch[1])) return send(res, 404, { erreur: "Données inconnues" });
      return send(res, 200, store.read(dataMatch[1]));
    }
    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) return send(res, 404, { erreur: "Route inconnue" });
    send(res, 200, await handler(await readBody(req)));
  } catch (err) {
    console.error(`[${req.method} ${pathname}]`, err);
    send(res, err.status || 500, { erreur: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ◉ JURGENITA en ligne — http://${HOST}:${PORT}`);
  console.log(LIVE ? `    Mode réel (${brain.MODEL})\n` : "    Mode démo (ajoutez ANTHROPIC_API_KEY dans .env pour le mode réel)\n");
});
