// Sous-étape 2b.2 : un jeton Google absent, vide, tronqué ou invalide ne doit
// ni empêcher le démarrage, ni laisser fuir le moindre extrait du jeton.
// Données sur des copies temporaires, jetons factices, aucun appel à Google.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [];
const newDir = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `jurgenita-2b2-${name}-`)); dirs.push(d); return d; };
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// Faux jeton de renouvellement Google, aux caractères peu courants.
const FAKE = "1//0gZq7XkP9wQm3Vt8RyHj2Lc6NbWfTd4Ux";
function fragments(text, min = 5) {
  const found = new Set();
  for (let i = 0; i + min <= FAKE.length; i++) if (text.includes(FAKE.slice(i, i + min))) found.add(FAKE.slice(i, i + min));
  return [...found];
}

// Démarre Jurgenita sur des copies temporaires ; `token` = contenu de google-token.json (null = absent).
async function startServer({ token = null, brandsJson = null } = {}) {
  const runtime = newDir("rt");
  const secrets = newDir("sec");
  const sauvegardes = newDir("sauvegardes"); // sauvegardes de droits (2b.4) propres à ce serveur
  if (token !== null) fs.writeFileSync(path.join(secrets, "google-token.json"), token);
  if (brandsJson !== null) fs.writeFileSync(path.join(runtime, "brands.json"), brandsJson);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: "0", JURGENITA_DEMO: "1", JURGENITA_NO_SCHEDULER: "1",
      JURGENITA_RUNTIME_DIR: runtime, JURGENITA_SECRETS_DIR: secrets, JURGENITA_SECRETS_BACKUP_DIR: sauvegardes,
      GOOGLE_CLIENT_ID: "faux-client.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "faux-secret",
      GOOGLE_BUSINESS_LOCATION: "accounts/1/locations/2",
      META_ACCESS_TOKEN: "", TELEGRAM_BOT_TOKEN: "", TIKTOK_ACCESS_TOKEN: "", LINKEDIN_ACCESS_TOKEN: "",
    },
  });
  let logs = "";
  child.stdout.on("data", (c) => (logs += c));
  child.stderr.on("data", (c) => (logs += c));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const port = await Promise.race([
    new Promise((resolve) => child.stdout.on("data", () => { const m = logs.match(/http:\/\/[\d.]+:(\d+)/); if (m) resolve(Number(m[1])); })),
    exited.then((code) => { throw Object.assign(new Error(`le serveur s'est arrêté au démarrage (code ${code})`), { logs: () => logs, code }); }),
  ]);
  return { port, logs: () => logs, exited, stop: () => child.kill(), tokenFile: path.join(secrets, "google-token.json") };
}

function call(port, method, p, body, brand) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "content-type": "application/json", ...(brand ? { "x-marque": brand } : {}) } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let json = null; try { json = JSON.parse(d); } catch { /* */ } resolve({ status: res.statusCode, body: json, text: d }); });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Parcourt les routes qui touchent à Google et renvoie ce que voit l'utilisateur.
async function exercise(port) {
  const responses = [];
  const keep = async (r) => (responses.push(r), r);
  const status = await keep(await call(port, "GET", "/api/status"));
  const inbox = await keep(await call(port, "GET", "/api/data/inbox"));
  const agenda = await keep(await call(port, "GET", "/api/data/agenda"));
  const community = await keep(await call(port, "GET", "/api/data/community", null, "resto-afrik"));
  const draft = await keep(await call(port, "POST", "/api/drafts", { canal: "email", destinataire: "a@mail.example", objet: "o", texte: "t" }));
  const review = await keep(await call(port, "POST", "/api/community/publish", { reseau: "google", ref: "accounts/1/locations/2/reviews/9", message: "Merci" }));
  const briefing = await keep(await call(port, "POST", "/api/briefing", {}));
  return { status, inbox, agenda, community, draft, review, briefing, shown: responses.map((r) => r.text).join("\n") };
}

const BROKEN = {
  "fichier vide": "",
  "espaces seulement": "   \n",
  "JSON tronqué": `{"refresh_token": "${FAKE.slice(0, 22)}`,
  "jeton sans guillemets": `{"refresh_token": ${FAKE}}`,
  "jeton au début du fichier": `${FAKE}{"scope": ""}`,
  "jeton recopié par le message d'erreur de Node": `{"refresh_token": ${FAKE.slice(4)}}`,
  "guillemets simples": `{'refresh_token': '${FAKE}'}`,
  "virgule manquante": `{"refresh_token": "${FAKE}" "scope": "business.manage"}`,
  "JSON valide sans jeton de renouvellement": `{"scope": "https://www.googleapis.com/auth/business.manage"}`,
  "jeton vide": `{"refresh_token": "", "scope": ""}`,
  "jeton qui n'est pas du texte": `{"refresh_token": 12345678901234}`,
  "tableau": `["${FAKE}"]`,
  "null": "null",
};

test("jeton Google absent : démarrage normal, Google simplement non connecté", async () => {
  const srv = await startServer();
  try {
    const r = await exercise(srv.port);
    assert.equal(r.status.status, 200);
    assert.deepEqual(r.status.body.connexions.gmail, { configure: true, connecte: false, avis_autorises: false, reconnexion: false });
    assert.equal(r.inbox.status, 200);
    assert.equal(r.draft.status, 200);
    assert.ok(!r.draft.body.gmail, "pas de brouillon Gmail sans connexion");
    assert.equal(r.review.status, 400);
  } finally { srv.stop(); }
});

for (const [name, content] of Object.entries(BROKEN)) {
  test(`jeton Google abîmé (${name}) : démarrage normal, reconnexion demandée, aucune fuite`, async () => {
    const srv = await startServer({ token: content });
    try {
      const r = await exercise(srv.port);
      assert.equal(r.status.status, 200, "le serveur répond");
      assert.deepEqual(r.status.body.connexions.gmail, { configure: true, connecte: false, avis_autorises: false, reconnexion: true });
      for (const key of ["inbox", "agenda", "community", "draft", "briefing"]) assert.equal(r[key].status, 200, key);
      assert.ok(Array.isArray(r.inbox.body) && r.inbox.body.length > 0, "boîte mail de démonstration servie à la place");
      assert.ok(!r.draft.body.gmail, "aucun brouillon tenté dans Gmail");
      assert.equal(r.review.status, 400, "réponse aux avis refusée proprement, sans erreur 500");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const logs = srv.logs();
      assert.deepEqual(fragments(logs), [], `fragments du jeton dans le journal :\n${logs}`);
      assert.deepEqual(fragments(r.shown), [], "fragments du jeton dans les réponses");
      assert.equal((logs.match(/Jeton Google illisible/g) || []).length, 1, "signalé une seule fois malgré plusieurs requêtes");
      assert.match(logs, /Gmail : à reconnecter/);
      assert.equal(fs.readFileSync(srv.tokenFile, "utf8"), content, "le fichier n'est ni modifié ni supprimé");
    } finally { srv.stop(); }
  });
}

test("jeton Google valide : connecté, avis autorisés, aucun appel réseau au démarrage", async () => {
  const srv = await startServer({ token: JSON.stringify({ refresh_token: FAKE, scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/business.manage" }) });
  try {
    const status = await call(srv.port, "GET", "/api/status");
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.connexions.gmail, { configure: true, connecte: true, avis_autorises: true, reconnexion: false });
    assert.match(srv.logs(), /Gmail : connecté/);
    assert.deepEqual(fragments(srv.logs() + status.text), []);
  } finally { srv.stop(); }
});

test("jeton Google valide sans l'autorisation des avis : connecté, avis non autorisés", async () => {
  const srv = await startServer({ token: JSON.stringify({ refresh_token: FAKE, scope: "https://www.googleapis.com/auth/gmail.readonly" }) });
  try {
    const status = await call(srv.port, "GET", "/api/status");
    assert.deepEqual(status.body.connexions.gmail, { configure: true, connecte: true, avis_autorises: false, reconnexion: false });
  } finally { srv.stop(); }
});

test("une vraie erreur fatale est journalisée sans extrait, puis le serveur s'arrête proprement (code 1)", async () => {
  // Liste des marques abîmée (traitée à la 2b.6) : reste une erreur fatale au démarrage.
  const content = `[{"id": "resto-afrik", "nom": ${FAKE.slice(4)}`;
  let err;
  try { await startServer({ brandsJson: content }); } catch (e) { err = e; }
  assert.ok(err, "le serveur doit s'arrêter");
  assert.equal(err.code, 1, "arrêt avec le code 1");
  const logs = err.logs();
  assert.match(logs, /\[fatal\]/);
  assert.match(logs, /SyntaxError: JSON invalide/);
  assert.ok(!logs.includes("<anonymous_script>"), "pas d'extrait du texte fautif affiché par Node");
  assert.deepEqual(fragments(logs), [], logs);
});

test("safe-error : aucune erreur JSON.parse réelle ne laisse passer d'extrait du texte", async () => {
  const { safeMessage, safeForLog } = await import(new URL("../src/safe-error.js", import.meta.url));
  let rawLeaks = 0;
  for (const text of Object.values(BROKEN).concat([`{"a": ${FAKE}}`, `{"refresh_token": "${FAKE}"`, FAKE, `"${FAKE}`, FAKE.slice(4), `[${FAKE.slice(4)}]`])) {
    let err;
    try { JSON.parse(text); } catch (e) { err = e; }
    if (!err) continue; // contenu JSON valide (ex. « null ») : rien à journaliser
    if (fragments(err.message).length) rawLeaks++;
    assert.deepEqual(fragments(safeMessage(err)), [], safeMessage(err));
    assert.deepEqual(fragments(safeForLog(err)), [], safeForLog(err));
    assert.match(safeMessage(err), /^JSON invalide/);
  }
  assert.ok(rawLeaks > 0, "le test doit inclure des messages bruts de Node qui recopient le texte");
  const plain = new Error("Google : quota dépassé");
  plain.body = { refresh_token: FAKE };
  assert.equal(safeMessage(plain), "Google : quota dépassé");
  assert.deepEqual(fragments(safeForLog(plain)), [], "propriétés attachées à l'erreur non affichées");
  assert.match(safeForLog(plain), /^Error: Google : quota dépassé\n\s+at /);
  assert.match(safeMessage("texte"), /pas une erreur \(string\)/);
});
