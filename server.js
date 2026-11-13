// Serveur Jurgenita : sert l'interface (public/), l'API JSON et les connecteurs.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import * as redaction from "./src/redact.js";
import { createStateStore } from "./src/oauth-states.js";
import { safeForLog } from "./src/safe-error.js";

// Les journaux masquent les secrets dès le démarrage, quel que soit le module qui écrit.
redaction.installConsoleRedaction();

// Une vraie erreur fatale (non rattrapée) : journalisée de façon sûre — sans
// extrait de fichier ni propriétés brutes, et masquée — puis arrêt propre avec
// le code 1, plutôt que de continuer dans un état incohérent. L'écriture est
// synchrone pour que le message ne soit pas perdu par l'arrêt (Windows).
function fatal(kind) {
  return (err) => {
    try { fs.writeSync(2, `${redaction.redact(`[fatal] ${kind} : ${safeForLog(err)}`)}\n`); }
    catch { /* rien de plus à faire : on s'arrête quand même */ }
    process.exit(1);
  };
}
process.on("uncaughtException", fatal("erreur non rattrapée"));
process.on("unhandledRejection", fatal("promesse rejetée non rattrapée"));

const here = path.dirname(fileURLToPath(import.meta.url));
if (fs.existsSync(path.join(here, ".env"))) process.loadEnvFile(path.join(here, ".env"));

const SECRET_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GOOGLE_CLIENT_SECRET", "META_ACCESS_TOKEN",
  "TIKTOK_ACCESS_TOKEN", "LINKEDIN_ACCESS_TOKEN", "TELEGRAM_BOT_TOKEN",
];
redaction.addSecretSource(() => SECRET_ENV.map((name) => process.env[name]));

const store = await import("./src/store.js");
const brands = await import("./src/brands.js");
const sources = await import("./src/sources.js");
const publisher = await import("./src/publisher.js");
const security = await import("./src/security.js");
const google = await import("./src/connectors/google.js");
const meta = await import("./src/connectors/meta.js");
const telegram = await import("./src/connectors/telegram.js");
const secretDir = await import("./src/secret-dir.js");
const LIVE = !process.env.JURGENITA_DEMO && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const brain = LIVE ? await import("./src/claude.js") : await import("./src/demo.js");
// Jetons des marques : dernières valeurs valides connues, pour qu'ils restent
// masqués même pendant un verrou passager sur leur fichier (masquage seulement).
redaction.addSecretSource(() => brands.secretsForRedaction());

const PORT = Number(process.env.PORT || 3000);
// Pas d'authentification : on n'écoute que sur la machine locale par défaut.
const HOST = process.env.HOST || "127.0.0.1";
const GOOGLE_REDIRECT = `http://127.0.0.1:${PORT}/auth/google/callback`;
const PUBLIC_DIR = path.join(here, "public");
const GLOBAL_DATA = { inbox: () => sources.inbox(), agenda: () => sources.agenda(), drafts: () => store.read("drafts") };
const BRAND_DATA = {
  profile: (b) => store.read("profile", b),
  notes: (b) => store.read("notes", b),
  veille: (b) => store.read("veille", b),
  calendar: (b) => sources.calendar(b),
  community: (b) => sources.community(b),
  stats: (b) => sources.stats(b),
  ads: (b) => sources.ads(b),
};
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json" };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

// Taille maximale du corps d'une requête : 1 Mo, sauf pour l'analyse d'images.
const BODY_LIMIT = 1_000_000;
const BODY_LIMITS = { "/api/vision": 20_000_000 };

// Un corps trop gros est lu jusqu'au bout sans être gardé en mémoire : couper la
// connexion en plein envoi ferait voir au navigateur une erreur réseau au lieu
// du message 413 (le délai maximal de Node, requestTimeout, borne la lecture).
function receive(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = Number(req.headers["content-length"]) > limit;
    req.on("data", (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
      } else chunks.push(chunk);
    });
    req.on("end", () => (tooBig ? reject(fail(413, "Requête trop volumineuse")) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

async function readBody(req, limit = BODY_LIMIT) {
  const raw = await receive(req, limit);
  if (!raw.length) return {};
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw fail(400, "Corps JSON invalide");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw fail(400, "Le corps de la requête doit être un objet JSON");
  return body;
}

// Ce que voit le navigateur quand une erreur survient. Les erreurs prévues
// (statut < 500, refus, services externes) gardent leur message, masqué ;
// les erreurs inattendues donnent un message générique et une référence,
// le détail n'allant que dans le journal.
function publicError(err) {
  // Fichier momentanément verrouillé : message prévu pour l'utilisateur, à réessayer.
  if (err.status === 503 && err.retryAfter) return { status: 503, erreur: redaction.redact(err.message), retryAfter: err.retryAfter };
  if (err.status && err.status < 500) return { status: err.status, erreur: redaction.redact(err.message) };
  if (err instanceof Anthropic.APIError) {
    const why = { 401: "clé API refusée", 403: "accès refusé", 429: "trop de demandes, réessayez dans un instant" }[err.status] || "service momentanément indisponible";
    return { status: 502, erreur: `Claude : ${why}`, log: true };
  }
  if (err.constructor?.name === "RefusalError") return { status: 422, erreur: err.message };
  // Erreur levée volontairement par Jurgenita ou par un connecteur (Error simple, sans code système).
  if (err.constructor === Error && !err.code) {
    const external = /^(Meta|Google|TikTok|LinkedIn|Telegram)\b/.test(err.message);
    return { status: external ? 502 : 500, erreur: redaction.redact(err.message), log: true };
  }
  const ref = randomBytes(4).toString("hex");
  return { status: 500, erreur: `Erreur interne (réf. ${ref}). Le détail est dans le journal du serveur.`, log: true, ref };
}

const notify = async (text) => {
  if (!telegram.ready()) return;
  try { await telegram.send(text); } catch (err) { console.error("[telegram]", err.message); }
};

// Briefing pour Telegram : un message par marque, pas plus d'une fois par jour.
let lastTelegramBriefing = null;
async function sendTelegramBriefing() {
  for (const b of brands.list()) {
    await telegram.send(`━━ ${b.nom.toUpperCase()} ━━\n\n${telegram.formatBriefing(await brain.briefing(b.id))}`);
  }
  lastTelegramBriefing = new Date().toDateString();
}

// Données réunies pour le rapport client, puis analysées par Jurgenita.
async function buildReport(brand) {
  const [statistiques, publicite, communaute] = await Promise.all([sources.stats(brand), sources.ads(brand), sources.community(brand)]);
  const calendrier = sources.calendar(brand);
  const parType = {};
  for (const c of communaute) parType[c.type] = (parType[c.type] || 0) + 1;
  const data = {
    marque: brands.get(brand).nom,
    genere_le: new Date().toISOString(),
    statistiques,
    publicite: {
      ...publicite,
      total_depense: Number(publicite.annonces.reduce((n, a) => n + a.depense, 0).toFixed(2)),
      total_conversions: publicite.annonces.reduce((n, a) => n + (a.conversions || 0), 0),
    },
    communaute: { interactions: communaute.length, par_type: parType },
    contenus: {
      publies: calendrier.filter((x) => x.statut === "publié").length,
      planifies: calendrier.filter((x) => !["publié", "échec"].includes(x.statut)).length,
    },
  };
  return { donnees: data, analyse: await brain.reportInsights(data, brand) };
}

const VALIDATION_VISIBLE = ["en validation", "modifs demandées", "approuvé", "publié"];

const routes = {
  "GET /api/status": (body, brand) => ({
    mode: LIVE ? "live" : "demo",
    modele: LIVE ? brain.MODEL : null,
    marque: brand,
    marques: brands.list(),
    profil: store.read("profile", brand),
    connexions: {
      ...sources.connections(brand),
      telegram: { configure: telegram.configured(), pret: telegram.ready() },
      protection_secrets: secretDir.rapportPublic(secretDir.dernierRapport()),
    },
  }),

  // Marques
  "POST /api/brands": (body) => brands.create(body),
  "POST /api/brands/delete": async (body) => {
    await brands.remove(body.id);
    return { ok: true };
  },
  "PUT /api/brand/connexions": async (body, brand) => {
    await brands.saveConfig(brand, body);
    return brands.connectionStatus(brand);
  },
  "POST /api/brand/validation-link": async (body, brand) => ({ chemin: `/validation/${await brands.validationToken(brand)}` }),
  "PUT /api/profile": (body, brand) => store.write("profile", { ...store.read("profile", brand), ...body }, brand),

  // Assistant
  "POST /api/briefing": (body, brand) => brain.briefing(brand),
  "POST /api/email/reply": (body, brand) => brain.emailReply(body, brand),
  "POST /api/studio": (body, brand) => {
    if (!body.sujet?.trim()) throw fail(400, "Indiquez un sujet");
    return brain.contentStudio(body, brand);
  },
  "POST /api/vision": (body, brand) => {
    if (!Array.isArray(body.images) || !body.images.length) throw fail(400, "Aucune image reçue");
    return brain.visionReport(body, brand);
  },
  "POST /api/chat": (body, brand) => {
    if (!body.message?.trim()) throw fail(400, "Message vide");
    return brain.chat({ conversationId: body.conversationId || randomUUID(), message: body.message }, brand);
  },
  "POST /api/chat/reset": (body, brand) => (brain.resetConversation(body.conversationId, brand), { ok: true }),

  // Communauté
  "POST /api/community": (body, brand) => brain.communityTriage(brand),
  "POST /api/community/publish": async (body, brand) => {
    if (!body.message?.trim()) throw fail(400, "Réponse vide");
    if (body.reseau === "google") {
      if (!sources.googleState().avis_autorises) throw fail(400, "Avis Google non connectés (reconnectez Google depuis Profil → Connexions)");
      await google.replyReview(body.ref, body.message);
      return { ok: true };
    }
    const cfg = brands.config(brand).meta;
    if (!meta.configured(cfg)) throw fail(400, "Meta n'est pas connecté pour cette marque");
    await meta.reply(cfg, body);
    return { ok: true };
  },

  // Calendrier, validation et publication
  "POST /api/calendar": (body, brand) => store.append("calendar", { statut: "idée", heure: "18:00", legende: "", image_url: "", ...body }, brand),
  "POST /api/calendar/update": (body, brand) => {
    const { id, ...changes } = body;
    if (changes.statut && !publisher.STATUTS.includes(changes.statut)) throw fail(400, "Statut inconnu");
    if (changes.statut === "publié") throw fail(400, "Utilisez « Publier maintenant »");
    return sources.updateCalendarItem(brand, id, changes);
  },
  "POST /api/calendar/delete": (body, brand) => (sources.removeCalendarItem(brand, body.id), { ok: true }),
  "POST /api/calendar/publish": (body, brand) => publisher.publishNow(brand, body.id),

  // Publicité
  "POST /api/ads/generate": (body, brand) => {
    if (!body.produit?.trim()) throw fail(400, "Décrivez le produit ou l'offre");
    return brain.adsGenerator(body, brand);
  },
  "POST /api/ads/review": (body, brand) => brain.adsReview(brand),

  // Veille et rapport
  "POST /api/veille": (body, brand) => brain.veille(brand),
  "GET /api/rapport": (body, brand) => buildReport(brand),

  // Divers
  "POST /api/drafts": async (body, brand) => {
    const draft = store.append("drafts", { ...body, marque: brand, cree: new Date().toISOString() });
    // Si Gmail est connecté, le brouillon d'un mail est aussi créé dans Gmail.
    if (body.canal === "email" && sources.googleState().connecte) {
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
  "POST /api/reset": () => (store.reset(), { ok: true }),
};

// Espace de validation du client : accessible avec le seul lien secret.
async function handleValidation(req, res, url) {
  const token = url.pathname.split("/")[3];
  const brand = brands.brandByValidationToken(token);
  if (!brand) return send(res, 404, { erreur: "Lien de validation invalide" });
  if (req.method === "GET") {
    return send(res, 200, {
      marque: brand.nom,
      contenus: sources.calendar(brand.id).filter((x) => VALIDATION_VISIBLE.includes(x.statut))
        .map(({ id, date, heure, plateforme, format, sujet, legende, image_url, statut, commentaire_client }) => ({ id, date, heure, plateforme, format, sujet, legende, image_url, statut, commentaire_client })),
    });
  }
  const body = await readBody(req);
  const item = sources.calendar(brand.id).find((x) => x.id === body.id);
  if (!item || item.statut !== "en validation") return send(res, 400, { erreur: "Ce contenu n'attend pas de validation" });
  if (!["approuver", "modifier"].includes(body.decision)) return send(res, 400, { erreur: "Décision inconnue" });
  const commentaire = String(body.commentaire || "").slice(0, 2000);
  const updated = sources.updateCalendarItem(brand.id, item.id, {
    statut: body.decision === "approuver" ? "approuvé" : "modifs demandées",
    commentaire_client: commentaire,
  });
  await notify(`${body.decision === "approuver" ? "👍" : "✏️"} ${brand.nom} — le client a ${body.decision === "approuver" ? "approuvé" : "demandé des modifications sur"} « ${item.sujet} »${commentaire ? `\n« ${commentaire} »` : ""}`);
  return send(res, 200, { ok: true, statut: updated.statut });
}

// Connexion Google (OAuth) : /auth/google redirige vers Google, qui revient sur le callback.
const oauthStates = createStateStore();
async function handleAuth(req, res, url) {
  if (url.pathname === "/auth/google") {
    if (!google.configured()) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Ajoutez GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env (voir CONNEXIONS.md).");
      return;
    }
    const state = oauthStates.create();
    res.writeHead(302, { location: google.authUrl(GOOGLE_REDIRECT, state) }).end();
    return;
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  let message = "Votre compte Google est connecté. Vous pouvez fermer cet onglet.";
  if (!oauthStates.consume(state)) message = "Lien de connexion expiré. Recommencez depuis Jurgenita.";
  else if (!code) message = `Connexion annulée (${url.searchParams.get("error") || "aucun code"}).`;
  else {
    try { await google.handleCallback(code, GOOGLE_REDIRECT); }
    catch (err) { message = `Échec : ${err.message}`; }
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Jurgenita</title><body style="background:#05080f;color:#e6f1ff;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><p>${message.replace(/[<>&]/g, "")}</p><p><a style="color:#4fd8ff" href="/">Retour à Jurgenita</a></p></div>`);
}

function serveFile(res, file) {
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("Introuvable");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

function brandOf(req, url) {
  const id = url.searchParams.get("marque") || req.headers["x-marque"] || brands.defaultId();
  return brands.get(String(id)).id;
}

// Noms de site acceptés, fixés au démarrage d'après le port réel.
let allowedHosts = new Set();

const server = http.createServer(async (req, res) => {
  for (const [name, value] of Object.entries(security.SECURITY_HEADERS)) res.setHeader(name, value);
  const refused = security.check(req, allowedHosts);
  if (refused) return send(res, refused.status, { erreur: refused.erreur });

  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/auth/google")) return await handleAuth(req, res, url);
    if (url.pathname.startsWith("/api/validation/")) return await handleValidation(req, res, url);
    if (url.pathname.startsWith("/validation/")) return serveFile(res, path.join(PUBLIC_DIR, "validation.html"));
    if (!url.pathname.startsWith("/api/")) {
      return serveFile(res, path.normalize(path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname)));
    }

    const brand = brandOf(req, url);
    const dataMatch = req.method === "GET" && url.pathname.match(/^\/api\/data\/(\w+)$/);
    if (dataMatch) {
      const name = dataMatch[1];
      if (GLOBAL_DATA[name]) return send(res, 200, await GLOBAL_DATA[name]());
      if (BRAND_DATA[name]) return send(res, 200, await BRAND_DATA[name](brand));
      if (name === "brands") return send(res, 200, brands.list());
      throw fail(404, "Données inconnues");
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { erreur: "Route inconnue" });
    const body = req.method === "GET" ? {} : await readBody(req, BODY_LIMITS[url.pathname]);
    send(res, 200, await handler(body, brand));
  } catch (err) {
    const pub = publicError(err);
    if (pub.log) console.error(`[${req.method} ${url.pathname}]${pub.ref ? ` réf. ${pub.ref}` : ""} ${safeForLog(err)}`);
    if (!res.headersSent) send(res, pub.status, { erreur: pub.erreur }, pub.retryAfter ? { "retry-after": String(pub.retryAfter) } : {});
  }
});

// Protection du dossier des secrets (2b.4) : vérifiée, et corrigée par
// resserrement si c'est sûr, AVANT d'accepter la moindre requête. Ne bloque
// jamais le démarrage : une situation dangereuse ou incertaine donne un
// avertissement persistant (journal, Profil → Connexions).
await secretDir.ensureSecretsDir();

server.listen(PORT, HOST, () => {
  allowedHosts = security.allowedHosts(server.address().port);
  const c = sources.connections(brands.defaultId());
  console.log(`\n  ◉ JURGENITA en ligne — http://${HOST}:${server.address().port}`);
  console.log(LIVE ? `    Cerveau : ${brain.MODEL}` : "    Cerveau : mode démo (ajoutez ANTHROPIC_API_KEY dans .env)");
  console.log(`    Marques : ${brands.list().map((b) => b.nom).join(", ")}`);
  console.log(`    Gmail : ${c.gmail.connecte ? "connecté" : c.gmail.reconnexion ? "à reconnecter (jeton Google illisible, voir Profil → Connexions)" : c.gmail.configure ? "à connecter depuis le Profil" : "non configuré"}`);
  console.log(`    Telegram : ${telegram.ready() ? "prêt" : telegram.configured() ? "envoyez un message au bot pour obtenir TELEGRAM_CHAT_ID" : "non configuré"}\n`);
  const health = brands.secretsHealth();
  if (health.illisibles.length) {
    console.warn(`  ⚠ Accès illisibles pour : ${health.illisibles.join(", ")}. Ils ne seront pas écrasés (voir Profil → Connexions).\n`);
  }
  if (health.fichiers_temporaires) {
    console.warn(`  ⚠ ${health.fichiers_temporaires} fichier(s) temporaire(s) d'une écriture interrompue dans data/secrets/brands/ : ignorés, vos accès ne sont pas touchés.\n`);
  }
  const protection = secretDir.dernierRapport();
  for (const ligne of secretDir.lignesJournal(protection)) (protection?.niveau === "sur" ? console.log : console.warn)(ligne);
  if (protection) console.log("");
  if (!security.isLoopback(HOST)) {
    console.warn("  ⚠ Jurgenita est ouverte au réseau (HOST) alors qu'elle n'a pas encore de connexion par mot de passe.");
    console.warn("    Toute personne qui atteint cette adresse peut lire vos données et agir. Ajoutez son nom à JURGENITA_ALLOWED_HOSTS seulement sur un réseau de confiance.\n");
  }
});

// Publication programmée : vérifie chaque minute les contenus approuvés.
if (!process.env.JURGENITA_NO_SCHEDULER) {
  setInterval(() => publisher.tick(notify).catch((err) => console.error("[publication]", err.message)), 60_000);
}

if (telegram.configured()) {
  telegram.listen(async (text) => {
    if (/^\/?briefing$/i.test(text)) {
      await sendTelegramBriefing();
      return "Voilà pour ce matin, Boss.";
    }
    if (text === "/start") return "Jurgenita à votre service. Écrivez « briefing » ou posez-moi une question.";
    return (await brain.chat({ conversationId: "telegram", message: text }, brands.defaultId())).texte;
  });

  // Briefing automatique à l'heure de réveil (heure de Paris).
  setInterval(async () => {
    if (!telegram.ready()) return;
    const now = new Date();
    const hm = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
    if (hm !== store.read("profile", brands.defaultId()).heure_reveil || lastTelegramBriefing === now.toDateString()) return;
    try { await sendTelegramBriefing(); }
    catch (err) { console.error("[telegram] briefing automatique :", err.message); }
  }, 30_000);
}
