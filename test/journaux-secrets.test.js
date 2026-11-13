// Journaux et secrets (corrections de la sous-étape 2a) :
// 1. lire un fichier de secrets abîmé ne doit jamais recopier un extrait de
//    son contenu dans le journal ;
// 2. pendant la collecte des secrets à masquer, les valeurs déjà connues
//    restent masquées, sans boucle infinie.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import util from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonFile } from "../src/atomic-file.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Adresse file:// d'un module de src/, utilisable dans import() sous Windows comme ailleurs
// (un chemin absolu « C:\… » y est refusé).
const srcUrl = (...parts) => pathToFileURL(path.join(root, "src", ...parts)).href;
const dirs = [];
const newDir = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `jurgenita-journaux-${name}-`)); dirs.push(d); return d; };
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// Jeton factice aux caractères peu courants, pour repérer le moindre extrait.
const TOKEN = "Zq7XkP9wQm3Vt8RyHj2Lc6Nb";
const FRAGMENT = 5;

function fragmentsOf(text, secret = TOKEN, min = FRAGMENT) {
  const found = [];
  for (let i = 0; i + min <= secret.length; i++) if (text.includes(secret.slice(i, i + min))) found.push(secret.slice(i, i + min));
  return found;
}

// Variantes de fichiers abîmés : formes typiques, puis le fichier valide
// tronqué à CHAQUE position et privé de CHAQUE guillemet ou deux-points.
function corruptions() {
  const valid = JSON.stringify({ meta_token: TOKEN, meta_page_id: "42", tiktok_token: TOKEN }, null, 2);
  const list = [
    `{"meta_token": "${TOKEN}" "meta_page_id": "42"}`,
    `{"meta_token": ${TOKEN}}`,
    `${TOKEN}{"a":1}`,
    `{'meta_token': '${TOKEN}'}`,
    `xx{"meta_token": "${TOKEN}"}`,
    `{"meta_token": "${TOKEN}",}`,
    `{"meta_token": "${TOKEN}"}}`,
    `[${TOKEN}]`,
    `"${TOKEN}"`,
    `{"meta_token": "${TOKEN}\u0000"}`,
  ];
  for (let i = 1; i < valid.length; i++) list.push(valid.slice(0, i));
  for (let i = 0; i < valid.length; i++) if ("\":,{}".includes(valid[i])) list.push(valid.slice(0, i) + valid.slice(i + 1));
  return list.filter((c) => { try { const v = JSON.parse(c); return v === null || typeof v !== "object" || Array.isArray(v); } catch { return true; } });
}

// Lance Jurgenita (masquage installé comme dans server.js) sur une liste de
// marques dont les fichiers d'accès sont abîmés, et renvoie le journal produit.
function runWithBrokenBrands(contents) {
  const runtime = newDir("rt");
  const secrets = newDir("sec");
  fs.mkdirSync(path.join(secrets, "brands"));
  const ids = contents.map((_, i) => `marque-${i}`);
  fs.writeFileSync(path.join(runtime, "brands.json"), JSON.stringify(ids.map((id) => ({ id, nom: id, couleur: "#000" }))));
  contents.forEach((c, i) => fs.writeFileSync(path.join(secrets, "brands", `${ids[i]}.json`), c));
  const script = `
    import * as redaction from ${JSON.stringify(srcUrl("redact.js"))};
    redaction.installConsoleRedaction();
    const brands = await import(${JSON.stringify(srcUrl("brands.js"))});
    redaction.addSecretSource(() => brands.list().flatMap((b) => { const c = brands.config(b.id); return [c.meta.token, c.tiktok.token, c.linkedin.token]; }));
    for (const b of brands.list()) brands.connectionStatus(b.id);
    try { await brands.saveConfig(brands.list()[0].id, { meta_token: "x" }); } catch (e) { console.error("refus :", e); }
    console.error("santé :", brands.secretsHealth());`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, JURGENITA_RUNTIME_DIR: runtime, JURGENITA_SECRETS_DIR: secrets, META_ACCESS_TOKEN: "", TIKTOK_ACCESS_TOKEN: "", LINKEDIN_ACCESS_TOKEN: "" },
  });
  assert.equal(run.status, 0, run.stderr.slice(0, 500));
  return { log: run.stdout + run.stderr, count: contents.length };
}

// ---------- Correction 1 : aucun extrait de secret dans le journal ----------

test("problème 1 : les deux cas de l'audit ne laissent passer aucun extrait du jeton", () => {
  const { log } = runWithBrokenBrands([`{"meta_token": ${TOKEN}}`, `${TOKEN}{"a":1}`]);
  assert.deepEqual(fragmentsOf(log), [], `extraits trouvés dans :\n${log}`);
  assert.equal((log.match(/Fichier illisible/g) || []).length, 2, "chaque fichier est quand même signalé");
});

test("aucun extrait de jeton, quelle que soit la façon dont le fichier est abîmé", () => {
  const cases = corruptions();
  assert.ok(cases.length > 100, `${cases.length} variantes`);
  const { log } = runWithBrokenBrands(cases);
  assert.deepEqual(fragmentsOf(log), [], "aucun extrait de 5 caractères ou plus");
  assert.equal((log.match(/Fichier illisible/g) || []).length, cases.length, "chaque variante est signalée");
});

test("le journal garde les informations utiles au diagnostic, sans contenu", () => {
  const { log } = runWithBrokenBrands([`{"meta_token": "${TOKEN}" "page": 1}`, "", "[1,2]"]);
  assert.match(log, /marque-0.*JSON invalide.*position \d+/, "catégorie et position");
  assert.match(log, /marque-1.*fichier vide/);
  assert.match(log, /marque-2.*pas un objet JSON/);
  assert.match(log, /\d+ octets/, "taille du fichier");
});

test("l'erreur de lecture elle-même ne transporte aucun extrait (même affichée en entier)", () => {
  const dir = newDir("erreur");
  const file = path.join(dir, "kora.json");
  for (const content of [`{"meta_token": ${TOKEN}}`, `${TOKEN}{"a":1}`]) {
    fs.writeFileSync(file, content);
    const { erreur } = readJsonFile(file);
    const shown = util.inspect(erreur, { depth: 5 }) + JSON.stringify(erreur) + String(erreur);
    assert.deepEqual(fragmentsOf(shown), [], shown);
  }
});

// ---------- Correction 2 : masquage pendant la collecte ----------

// Lance un petit programme avec le masquage installé et des sources de secrets
// qui écrivent elles-mêmes dans le journal pendant la collecte.
function runCollection(body) {
  const script = `
    import * as redaction from ${JSON.stringify(srcUrl("redact.js"))};
    redaction.installConsoleRedaction();
    ${body}`;
  const started = Date.now();
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  return { out: run.stdout + run.stderr, status: run.status, signal: run.signal, ms: Date.now() - started };
}

const S1 = "premier-secret-connu-AbC123";
const S2 = "second-secret-connu-XyZ789";

test("problème 2 : un secret déjà connu reste masqué dans un message écrit pendant la collecte", () => {
  const { out, status } = runCollection(`
    let calls = 0;
    redaction.addSecretSource(() => [${JSON.stringify(S1)}]);
    redaction.addSecretSource(() => { calls++; console.error("pendant la collecte :", ${JSON.stringify(S1)}, ${JSON.stringify(S2)}); return [${JSON.stringify(S2)}]; });
    console.log("premier message");
    console.log("second message", ${JSON.stringify(S1)}, ${JSON.stringify(S2)});
    console.log("collectes :", calls);`);
  assert.equal(status, 0, out);
  assert.ok(!out.includes(S1), `S1 visible :\n${out}`);
  // S2 n'est connu qu'après la première collecte complète : au premier passage,
  // il ne peut être masqué que si une collecte précédente l'a déjà trouvé.
  const lines = out.trim().split("\n");
  assert.ok(lines.filter((l) => l.startsWith("pendant la collecte")).slice(1).every((l) => !l.includes(S2)), `S2 visible après la première collecte :\n${out}`);
  assert.match(out, /second message \[masqué\] \[masqué\]/);
});

test("pas de boucle infinie : une source qui écrit à chaque collecte se termine vite", () => {
  const { status, signal, ms, out } = runCollection(`
    let calls = 0;
    redaction.addSecretSource(() => { calls++; console.error("source bavarde", calls); return ["valeur-secrete-stable-123"]; });
    for (let i = 0; i < 50; i++) console.log("message", i, "valeur-secrete-stable-123");
    console.log("fin, collectes :", calls);`);
  assert.equal(signal, null, "le programme n'a pas été tué par le délai");
  assert.equal(status, 0, out);
  assert.ok(ms < 5000, `${ms} ms`);
  // Le compteur est lu avant la collecte de ce dernier message : 50.
  assert.match(out, /fin, collectes : 50/, "une collecte par message, jamais imbriquée");
  assert.equal((out.match(/source bavarde/g) || []).length, 51);
  assert.ok(!out.includes("valeur-secrete-stable-123"));
});

test("pas de boucle infinie avec un vrai fichier d'accès abîmé (même chaîne que le serveur)", () => {
  const { log } = runWithBrokenBrands(["{ tronqué", `{"meta_token": ${TOKEN}}`]);
  assert.ok(log.length < 20_000, `journal de ${log.length} caractères`);
  assert.equal((log.match(/Fichier illisible/g) || []).length, 2, "un seul signalement par fichier");
});

test("un secret supprimé n'est plus masqué à tort après une nouvelle collecte complète", () => {
  const { out } = runCollection(`
    let secrets = ["ancien-secret-a-oublier-123"];
    redaction.addSecretSource(() => secrets);
    console.log("1", "ancien-secret-a-oublier-123");
    secrets = [];
    console.log("2", "ancien-secret-a-oublier-123");`);
  assert.match(out, /^1 \[masqué\]$/m);
  assert.match(out, /^2 ancien-secret-a-oublier-123$/m, "la liste est rafraîchie à chaque collecte complète");
});

test("les messages normaux sont masqués exactement comme avant", () => {
  const { out } = runCollection(`
    redaction.addSecretSource(() => ["jeton-marque-kora-AbCdEf123456", "court"]);
    for (const m of ${JSON.stringify([
      "échec avec jeton-marque-kora-AbCdEf123456 sur la page",
      "https://graph.facebook.com/v23.0/1/feed?access_token=EAABsbCS1iHgBAKZBsecret",
      "Authorization: Bearer ya29.a0AfH6SMBsecretvalue123",
      "refresh_token=1//0gAbCdEfGhIjKlMn&client_secret=GOCSPX-abcdef",
      "sk-ant-api03-AbCdEfGhIjKlMnOpQr",
      "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getUpdates",
      "texte normal : publication Instagram approuvée pour Maison Kora",
      "identifiant court et page 42",
    ])}) console.log(m);`);
  assert.equal(out.trim(), [
    "échec avec [masqué] sur la page",
    "https://graph.facebook.com/v23.0/1/feed?access_token=[masqué]",
    "Authorization: Bearer [masqué]",
    "refresh_token=[masqué]&client_secret=[masqué]",
    "[masqué]",
    "https://api.telegram.org/[masqué]/getUpdates",
    "texte normal : publication Instagram approuvée pour Maison Kora",
    "identifiant court et page 42",
  ].join("\n"));
});
