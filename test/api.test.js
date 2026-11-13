// Tests de bout en bout de l'API, en mode démo (aucune clé ni compte requis).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-test-"));
const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-secrets-"));
// Sauvegardes de droits (2b.4) : dossier propre à ce serveur de test, supprimé à la fin, même en cas d'échec.
const sauvegardesDir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-api-sauvegardes-"));
let server;
let base;

before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: "0",
      JURGENITA_DEMO: "1",
      JURGENITA_RUNTIME_DIR: runtimeDir,
      JURGENITA_SECRETS_DIR: secretsDir,
      JURGENITA_SECRETS_BACKUP_DIR: sauvegardesDir,
      JURGENITA_NO_SCHEDULER: "1",
      // Les connecteurs restent éteints, même si un .env local les configure.
      GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", META_ACCESS_TOKEN: "", TELEGRAM_BOT_TOKEN: "",
      TIKTOK_ACCESS_TOKEN: "", LINKEDIN_ACCESS_TOKEN: "", GOOGLE_BUSINESS_LOCATION: "",
    },
  });
  base = await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => {
      const m = String(chunk).match(/http:\/\/[\d.]+:(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    server.on("exit", (code) => reject(new Error(`Le serveur s'est arrêté (code ${code})`)));
  });
});

after(() => {
  server.kill();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.rmSync(secretsDir, { recursive: true, force: true });
  fs.rmSync(sauvegardesDir, { recursive: true, force: true });
});

async function call(pathname, body, method = body === undefined ? "GET" : "POST", brand) {
  const res = await fetch(base + pathname, {
    method,
    headers: { ...(brand ? { "x-marque": brand } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("le statut annonce le mode démo et aucune connexion", async () => {
  const { status, body } = await call("/api/status");
  assert.equal(status, 200);
  assert.equal(body.mode, "demo");
  assert.equal(body.connexions.gmail.connecte, false);
  assert.equal(body.connexions.marque.meta, false);
  assert.deepEqual(body.marques.map((b) => b.id), ["resto-afrik", "kora"]);
  assert.equal(body.marque, "resto-afrik", "la première marque est active par défaut");
  assert.equal(body.connexions.telegram.pret, false);
});

test("le briefing trie chaque email et propose des priorités", async () => {
  const { body } = await call("/api/briefing", {});
  const inbox = (await call("/api/data/inbox")).body;
  assert.equal(body.emails.length, inbox.length);
  assert.ok(body.priorites.length >= 3);
  for (const e of body.emails) {
    assert.ok(["urgent", "a_repondre", "opportunite", "a_deleguer", "a_ignorer"].includes(e.categorie));
    if (e.repondre) assert.ok(e.brouillon.length > 0, `brouillon manquant pour ${e.id}`);
  }
  // La règle du profil « pas d'alcool fort » doit être respectée.
  assert.equal(body.emails.find((e) => e.id === "m7").categorie, "a_ignorer");
});

test("une réponse peut être rédigée pour un email existant, pas pour un inconnu", async () => {
  assert.equal((await call("/api/email/reply", { id: "m1" })).status, 200);
  assert.equal((await call("/api/email/reply", { id: "inconnu" })).status, 404);
});

test("le studio exige un sujet et renvoie un post par plateforme", async () => {
  assert.equal((await call("/api/studio", { sujet: " " })).status, 400);
  const { body } = await call("/api/studio", { sujet: "Le koki", plateformes: ["Instagram", "TikTok", "LinkedIn"] });
  assert.deepEqual(body.posts.map((p) => p.plateforme), ["Instagram", "TikTok", "LinkedIn"]);
  assert.ok(body.script_video.length > 0);
});

test("l'analyse visuelle refuse une requête sans image", async () => {
  assert.equal((await call("/api/vision", { images: [] })).status, 400);
  const { body } = await call("/api/vision", { images: [{ media_type: "image/jpeg", data: "AAAA" }] });
  assert.equal(typeof body.note_accroche, "number");
});

test("la console répond aux questions d'expertise", async () => {
  assert.equal((await call("/api/chat", { message: "" })).status, 400);
  const { body } = await call("/api/chat", { message: "Quelle est la meilleure heure pour publier ?" });
  assert.match(body.texte, /Instagram/);
});

test("le calendrier et les brouillons sont enregistrés hors des données de démo", async () => {
  const added = (await call("/api/calendar", { date: "2026-12-01", plateforme: "TikTok", format: "Vidéo", sujet: "Test" })).body;
  const calendar = (await call("/api/data/calendar")).body;
  assert.ok(calendar.some((x) => x.id === added.id));
  assert.ok(fs.existsSync(path.join(runtimeDir, "brands", "resto-afrik", "calendar.json")));
  await call("/api/reset", {});
  assert.ok(!(await call("/api/data/calendar")).body.some((x) => x.id === added.id));
});

test("Telegram et la publication Meta refusent tant qu'ils ne sont pas configurés", async () => {
  assert.equal((await call("/api/telegram/briefing", {})).status, 400);
  assert.equal((await call("/api/community/publish", { reseau: "instagram", ref: "1", message: "x" })).status, 400);
});

test("les données inconnues et les chemins hors de public/ sont refusés", async () => {
  assert.equal((await call("/api/data/secrets")).status, 404);
  const res = await fetch(`${base}/..%2Fserver.js`);
  assert.equal(res.status, 404);
  const home = await fetch(`${base}/`);
  assert.match(await home.text(), /J·U·R·G·E·N·I·T·A/);
});

// ---------- Marques ----------

test("chaque marque a ses propres données", async () => {
  const kora = (await call("/api/data/profile", undefined, "GET", "kora")).body;
  assert.equal(kora.marque, "Maison Kora");
  await call("/api/calendar", { date: "2026-12-02", plateforme: "LinkedIn", format: "Post", sujet: "Isolation" }, "POST", "kora");
  const koraCal = (await call("/api/data/calendar", undefined, "GET", "kora")).body;
  const restoCal = (await call("/api/data/calendar")).body;
  assert.ok(koraCal.some((x) => x.sujet === "Isolation"));
  assert.ok(!restoCal.some((x) => x.sujet === "Isolation"));
});

test("les dates du calendrier de démo sont relatives à aujourd'hui", async () => {
  const cal = (await call("/api/data/calendar")).body;
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  assert.ok(cal.some((x) => x.date === iso));
  assert.ok(cal.every((x) => !("decalage_jours" in x)));
});

test("une marque se crée, s'utilise et se retire", async () => {
  const { body: brand } = await call("/api/brands", { nom: "Café Équateur" });
  assert.equal(brand.id, "cafe-equateur");
  const { body: briefing } = await call("/api/briefing", {}, "POST", brand.id);
  assert.match(briefing.salutation, /Café Équateur/);
  assert.equal((await call("/api/data/stats", undefined, "GET", brand.id)).status, 200);
  await call("/api/brands/delete", { id: brand.id });
  assert.equal((await call("/api/data/profile", undefined, "GET", brand.id)).status, 404);
});

test("une marque inconnue ou mal formée est refusée", async () => {
  assert.equal((await call("/api/data/profile", undefined, "GET", "inconnue")).status, 404);
  assert.equal((await call("/api/data/profile", undefined, "GET", "../secrets")).status, 404);
  assert.equal((await call("/api/brands", { nom: " " })).status, 400);
});

test("les accès d'une marque sont enregistrés sans jamais être renvoyés", async () => {
  const { body } = await call("/api/brand/connexions", { meta_token: "SECRET123", meta_page_id: "42" }, "PUT", "kora");
  assert.equal(body.meta, true);
  assert.deepEqual(body.champs_renseignes.sort(), ["meta_page_id", "meta_token"]);
  // Un champ vide ne doit pas effacer le jeton enregistré.
  await call("/api/brand/connexions", { meta_token: "" }, "PUT", "kora");
  const status = (await call("/api/status", undefined, "GET", "kora")).body;
  assert.equal(status.connexions.marque.meta, true);
  assert.ok(!JSON.stringify(status).includes("SECRET123"));
  await call("/api/brand/connexions", { effacer: ["meta_token", "meta_page_id"] }, "PUT", "kora");
});

// ---------- Validation client et publication ----------

test("le client valide un contenu avec son lien secret", async () => {
  const { body: link } = await call("/api/brand/validation-link", {}, "POST", "kora");
  const token = link.chemin.split("/")[2];
  const page = await fetch(base + link.chemin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Validation des contenus/);

  const { body } = await call(`/api/validation/${token}`);
  assert.equal(body.marque, "Maison Kora");
  const pending = body.contenus.find((x) => x.statut === "en validation");
  assert.ok(pending);

  assert.equal((await call(`/api/validation/${token}`, { id: pending.id, decision: "supprimer" })).status, 400);
  const ok = await call(`/api/validation/${token}`, { id: pending.id, decision: "modifier", commentaire: "Plus de couleurs" });
  assert.equal(ok.body.statut, "modifs demandées");
  assert.equal((await call(`/api/validation/${token}`, { id: pending.id, decision: "approuver" })).status, 400, "une seule décision par passage en validation");
  const item = (await call("/api/data/calendar", undefined, "GET", "kora")).body.find((x) => x.id === pending.id);
  assert.equal(item.commentaire_client, "Plus de couleurs");
});

test("un lien de validation faux ne donne accès à rien", async () => {
  assert.equal((await call("/api/validation/faux-jeton-de-validation-123")).status, 404);
  assert.equal((await call("/api/validation/court")).status, 404);
});

test("seul un contenu approuvé peut partir, et jamais sans compte connecté", async () => {
  const cal = (await call("/api/data/calendar")).body;
  const draft = cal.find((x) => x.statut !== "approuvé");
  const approved = cal.find((x) => x.statut === "approuvé");
  assert.equal((await call("/api/calendar/publish", { id: draft.id })).status, 400);
  const demo = await call("/api/calendar/publish", { id: approved.id });
  assert.equal(demo.status, 400);
  assert.match(demo.body.erreur, /démonstration/, "un contenu de démo ne part jamais");
  const { body: own } = await call("/api/calendar", { date: "2026-12-03", heure: "10:00", plateforme: "Instagram", format: "Photo", sujet: "Vrai contenu" });
  await call("/api/calendar/update", { id: own.id, statut: "approuvé" });
  const res = await call("/api/calendar/publish", { id: own.id });
  assert.equal(res.status, 400);
  assert.match(res.body.erreur, /n'est pas connecté/);
  assert.equal((await call("/api/calendar/update", { id: draft.id, statut: "publié" })).status, 400);
  assert.equal((await call("/api/calendar/update", { id: draft.id, statut: "inventé" })).status, 400);
});

// ---------- Publicité, veille, rapport ----------

test("l'analyse publicitaire décide pour chaque annonce", async () => {
  const ads = (await call("/api/data/ads", undefined, "GET", "kora")).body;
  const { body } = await call("/api/ads/review", {}, "POST", "kora");
  assert.equal(body.decisions.length, ads.annonces.length);
  assert.equal(body.decisions.find((d) => d.annonce === "Reel essayage veste Kente").decision, "augmenter");
  assert.ok(body.alertes.some((a) => a.includes("Vidéo atelier Abidjan")), "une annonce non rentable doit être signalée");
});

test("le générateur d'annonces exige un produit et respecte les limites Google Ads", async () => {
  assert.equal((await call("/api/ads/generate", { produit: "" })).status, 400);
  const { body } = await call("/api/ads/generate", { produit: "Brunch du dimanche", plateformes: ["Meta Ads", "Google Ads"] });
  assert.equal(body.annonces.length, 6);
  for (const a of body.annonces.filter((x) => x.plateforme === "Google Ads")) {
    assert.ok(a.titre.length <= 30, `titre trop long : ${a.titre}`);
    assert.ok(a.description.length <= 90, `description trop longue : ${a.description}`);
  }
});

test("la veille et le rapport client sont disponibles", async () => {
  const veille = (await call("/api/veille", {}, "POST", "kora")).body;
  assert.ok(veille.mentions.length > 0);
  const { body } = await call("/api/rapport?marque=kora");
  assert.equal(body.donnees.marque, "Maison Kora");
  assert.equal(body.donnees.publicite.total_depense, 485);
  assert.ok(body.analyse.recommandations.length > 0);
  const page = await fetch(`${base}/rapport.html`);
  assert.match(await page.text(), /Enregistrer en PDF/);
});
