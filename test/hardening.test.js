// Étape 1 de la phase 2 : corrections secondaires.
// Corps de requête (JSON mal formé, tailles), erreurs génériques, masquage des
// secrets dans les journaux, connexions Google temporaires.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact, addSecretSource } from "../src/redact.js";
import { createStateStore } from "../src/oauth-states.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-etape1-"));
const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-etape1-secrets-"));
// Secrets factices : ils ne doivent jamais apparaître dans un journal ni une réponse.
const FAKE_META = "EAAFauxJetonMetaPourLesTests1234567890";
const FAKE_ANTHROPIC = "sk-ant-faux-jeton-pour-les-tests-0123456789";
let server;
let port;
let logs = "";

before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: "0",
      JURGENITA_DEMO: "1",
      JURGENITA_RUNTIME_DIR: runtimeDir,
      JURGENITA_SECRETS_DIR: secretsDir,
      JURGENITA_NO_SCHEDULER: "1",
      // Identifiants Google factices : seulement pour activer /auth/google,
      // aucun appel n'est fait à Google dans ces tests.
      GOOGLE_CLIENT_ID: "faux-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "faux-secret-client-google",
      META_ACCESS_TOKEN: FAKE_META, META_IG_USER_ID: "", META_PAGE_ID: "",
      ANTHROPIC_API_KEY: FAKE_ANTHROPIC,
      TELEGRAM_BOT_TOKEN: "", TIKTOK_ACCESS_TOKEN: "", LINKEDIN_ACCESS_TOKEN: "", GOOGLE_BUSINESS_LOCATION: "",
    },
  });
  server.stderr.on("data", (c) => (logs += c));
  server.stdout.on("data", (c) => (logs += c));
  port = await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => {
      const m = String(chunk).match(/http:\/\/[\d.]+:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    server.on("exit", (code) => reject(new Error(`Le serveur s'est arrêté (code ${code})`)));
  });
});

after(() => {
  server.kill();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.rmSync(secretsDir, { recursive: true, force: true });
});

// Requête brute : corps en plusieurs morceaux possible, en-têtes au choix.
function raw(method, pathname, { headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* HTML */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: data });
      });
    });
    req.on("error", reject);
    if (chunks) for (const c of chunks) req.write(c);
    else if (body !== undefined) req.write(body);
    req.end();
  });
}
const JSON_HEADERS = { "content-type": "application/json" };

// ---------- Corps des requêtes ----------

test("un JSON mal formé donne 400, pas 500", async () => {
  for (const body of ["{pas du json", "{\"id\": ", "'simple'", "\u0000"]) {
    const res = await raw("POST", "/api/calendar", { headers: JSON_HEADERS, body });
    assert.equal(res.status, 400, body);
    assert.equal(res.body.erreur, "Corps JSON invalide");
  }
});

test("un corps qui n'est pas un objet JSON est refusé (400)", async () => {
  for (const body of ["[1,2]", "null", "123", "\"texte\"", "true"]) {
    const res = await raw("POST", "/api/calendar", { headers: JSON_HEADERS, body });
    assert.equal(res.status, 400, body);
    assert.match(res.body.erreur, /objet JSON/);
  }
});

test("la taille maximale est de 1 Mo, sauf 20 Mo pour l'analyse d'images", async () => {
  const big = JSON.stringify({ sujet: "x".repeat(1_100_000) });
  assert.equal((await raw("POST", "/api/calendar", { headers: JSON_HEADERS, body: big })).status, 413, "annoncé par Content-Length");
  // Sans Content-Length (envoi en morceaux) : la limite est vérifiée au fil de la lecture.
  const pieces = Array.from({ length: 12 }, () => "x".repeat(100_000));
  const chunked = await raw("POST", "/api/calendar", { headers: JSON_HEADERS, chunks: ["{\"sujet\":\"", ...pieces, "\"}"] });
  assert.equal(chunked.status, 413, "envoi en morceaux");
  // L'analyse d'images accepte une grande photo (2 Mo)…
  const photo = JSON.stringify({ images: [{ media_type: "image/jpeg", data: "A".repeat(2_000_000) }] });
  assert.equal((await raw("POST", "/api/vision", { headers: JSON_HEADERS, body: photo })).status, 200);
  // …mais pas au-delà de 20 Mo.
  const huge = JSON.stringify({ images: [{ media_type: "image/jpeg", data: "A".repeat(20_100_000) }] });
  assert.equal((await raw("POST", "/api/vision", { headers: JSON_HEADERS, body: huge })).status, 413);
});

test("les requêtes normales et les corps vides fonctionnent toujours", async () => {
  assert.equal((await raw("POST", "/api/briefing", { headers: JSON_HEADERS })).status, 200, "corps vide");
  assert.equal((await raw("POST", "/api/briefing", { headers: JSON_HEADERS, body: "{}" })).status, 200);
  const created = await raw("POST", "/api/calendar", { headers: JSON_HEADERS, body: JSON.stringify({ date: "2026-12-01", sujet: "Étape 1 ✨" }) });
  assert.equal(created.status, 200);
  assert.equal(created.body.sujet, "Étape 1 ✨", "les caractères accentués et emoji passent intacts");
});

// ---------- Erreurs ----------

test("une erreur inattendue donne un message générique avec une référence, et le détail masqué dans le journal", async () => {
  // Fichier de données corrompu, contenant un secret : l'erreur de lecture le citerait.
  const file = path.join(runtimeDir, "brands", "resto-afrik", "notes.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `{ ${FAKE_META} corrompu`);
  const res = await raw("GET", "/api/data/notes");
  fs.rmSync(file);

  assert.equal(res.status, 500);
  const ref = res.body.erreur.match(/Erreur interne \(réf\. ([0-9a-f]{8})\)/)?.[1];
  assert.ok(ref, `message générique attendu, reçu : ${res.body.erreur}`);
  assert.ok(!res.text.includes(FAKE_META), "le secret n'est pas renvoyé au navigateur");
  assert.ok(!res.text.includes(runtimeDir), "le chemin interne n'est pas renvoyé au navigateur");

  await new Promise((r) => setTimeout(r, 100));
  assert.match(logs, new RegExp(`réf\\. ${ref}`), "la même référence est dans le journal");
  assert.match(logs, /SyntaxError/, "le détail de l'erreur est dans le journal");
  assert.ok(!logs.includes(FAKE_META), "le secret est masqué dans le journal");
});

test("les erreurs prévues gardent un message utile", async () => {
  const unknown = await raw("POST", "/api/email/reply", { headers: JSON_HEADERS, body: JSON.stringify({ id: "inconnu" }) });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.erreur, /introuvable/);
  const { body: own } = await raw("POST", "/api/calendar", { headers: JSON_HEADERS, body: JSON.stringify({ date: "2026-12-02", plateforme: "Instagram", sujet: "Sans compte" }) });
  await raw("POST", "/api/calendar/update", { headers: JSON_HEADERS, body: JSON.stringify({ id: own.id, statut: "approuvé" }) });
  const publish = await raw("POST", "/api/calendar/publish", { headers: JSON_HEADERS, body: JSON.stringify({ id: own.id }) });
  assert.equal(publish.status, 400);
  assert.match(publish.body.erreur, /n'est pas connecté/);
});

test("aucun secret configuré n'apparaît dans le journal de démarrage ni dans les réponses", async () => {
  const status = await raw("GET", "/api/status");
  assert.ok(!status.text.includes(FAKE_META) && !status.text.includes(FAKE_ANTHROPIC));
  assert.ok(!logs.includes(FAKE_META) && !logs.includes(FAKE_ANTHROPIC));
});

// ---------- Masquage des secrets ----------

test("les motifs de secrets courants sont masqués", () => {
  const cases = [
    ["https://graph.facebook.com/v23.0/1/media?fields=id&access_token=EAAB123secret", "access_token=[masqué]"],
    ["grant_type=refresh_token&refresh_token=1//0gSecretRefresh&client_secret=GOCSPX-abc", "refresh_token=[masqué]"],
    ["Authorization: Bearer ya29.a0AfH6SMBsecretvalue", "Bearer [masqué]"],
    ["clé sk-ant-api03-AbCdEfGhIjKlMnOp", "clé [masqué]"],
    ["https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage", "https://api.telegram.org/[masqué]/sendMessage"],
    ["jeton EAAGm0PX4ZCpsBAKZCZBabcdefghijklmnop seul", "jeton [masqué] seul"],
    ["ya29.A0ARrdaM-secret-google-token", "[masqué]"],
  ];
  for (const [input, expected] of cases) {
    const out = redact(input);
    assert.ok(out.includes(expected), `${input}\n→ ${out}`);
  }
  assert.ok(!redact(cases[1][0]).includes("GOCSPX"), "client_secret masqué");
});

test("les valeurs exactes des secrets configurés sont masquées, sans toucher au reste", () => {
  addSecretSource(() => ["mon-secret-tres-particulier", "court", null, undefined]);
  assert.equal(redact("échec avec mon-secret-tres-particulier pour la marque Kora"), "échec avec [masqué] pour la marque Kora");
  assert.equal(redact("identifiant court"), "identifiant court", "les valeurs trop courtes (identifiants) ne sont pas masquées");
  assert.equal(redact("Publication Instagram : contenu approuvé"), "Publication Instagram : contenu approuvé");
});

test("le masquage s'applique à tout console.* du serveur, objets et erreurs compris", () => {
  const script = `
    import { installConsoleRedaction, addSecretSource } from ${JSON.stringify(path.join(root, "src", "redact.js"))};
    installConsoleRedaction();
    addSecretSource(() => ["valeur-secrete-de-test"]);
    console.error("[meta]", new Error("échec https://x/?access_token=EAAsecretdanserreur123456789"));
    console.warn({ jeton: "valeur-secrete-de-test" });
    console.log("Bearer abcdefghijklmnop");
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const all = run.stdout + run.stderr;
  assert.ok(!/EAAsecret|valeur-secrete-de-test|abcdefghijklmnop/.test(all), all);
  assert.match(all, /access_token=\[masqué\]/);
  assert.match(all, /at .*\[eval/, "la pile d'appels reste dans le journal");
});

// ---------- Connexions Google temporaires ----------

test("state OAuth : aléatoire, à usage unique, expirant, en nombre limité", () => {
  let clock = 0;
  const store = createStateStore({ ttlMs: 1000, max: 3, now: () => clock });
  const a = store.create();
  const b = store.create();
  assert.notEqual(a, b);
  assert.ok(a.length >= 43, "256 bits aléatoires");
  assert.equal(store.consume(a), true);
  assert.equal(store.consume(a), false, "usage unique");
  assert.equal(store.consume("inconnu"), false);
  assert.equal(store.consume(undefined), false);
  clock = 1000;
  assert.equal(store.consume(b), false, "expiré");
  assert.equal(store.size, 0, "les expirés sont nettoyés");
  const c1 = store.create(), c2 = store.create(), c3 = store.create(), c4 = store.create();
  assert.equal(store.size, 3, "jamais plus que le maximum");
  assert.equal(store.consume(c1), false, "le plus ancien est abandonné");
  assert.ok([c2, c3, c4].every((s) => store.consume(s)));
});

test("retour Google : un state n'est accepté qu'une fois, les inconnus sont refusés", async () => {
  const start = await raw("GET", "/auth/google");
  assert.equal(start.status, 302);
  const state = new URL(start.headers.location).searchParams.get("state");
  assert.ok(state && state.length >= 43);
  // Retour sans code (l'utilisateur a refusé) : aucun appel à Google, le state est consommé.
  const first = await raw("GET", `/auth/google/callback?state=${state}&error=access_denied`);
  assert.match(first.text, /Connexion annulée/);
  const again = await raw("GET", `/auth/google/callback?state=${state}&error=access_denied`);
  assert.match(again.text, /Lien de connexion expiré/, "usage unique");
  const forged = await raw("GET", "/auth/google/callback?state=fabrique-par-un-attaquant&code=x");
  assert.match(forged.text, /Lien de connexion expiré/);
});

test("retour Google : au plus 50 connexions en attente", async () => {
  const states = [];
  for (let i = 0; i < 55; i++) states.push(new URL((await raw("GET", "/auth/google")).headers.location).searchParams.get("state"));
  const oldest = await raw("GET", `/auth/google/callback?state=${states[0]}&error=access_denied`);
  assert.match(oldest.text, /Lien de connexion expiré/, "les plus anciennes sont abandonnées");
  const newest = await raw("GET", `/auth/google/callback?state=${states.at(-1)}&error=access_denied`);
  assert.match(newest.text, /Connexion annulée/);
});
