// Sous-étape 2b.3 : écritures asynchrones et fichiers verrouillés.
//
// Ici, les verrous sont SIMULÉS (Linux n'a pas les verrous obligatoires de
// Windows) : les fonctions de node:fs sont remplacées le temps d'un test, soit
// par un fsImpl injecté, soit dans le serveur par un module préchargé
// (--import) écrit dans un dossier temporaire. Le code de production n'a aucun
// point d'entrée réservé aux tests. Les vrais verrous NTFS sont testés dans
// windows.test.js. Données factices, dossiers temporaires uniquement.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as af from "../src/atomic-file.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcUrl = (...parts) => pathToFileURL(path.join(root, "src", ...parts)).href;
const dirs = [];
const newDir = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `jurgenita-2b3-${name}-`)); dirs.push(d); return d; };
after(() => dirs.forEach((d) => { try { fs.chmodSync(path.join(d, "kora.json"), 0o600); } catch { /* */ } fs.rmSync(d, { recursive: true, force: true }); }));

const locked = (code = "EBUSY") => Object.assign(new Error(`${code}: resource busy or locked`), { code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTemp = (p) => String(p).endsWith(af.TEMP_SUFFIX);
// fs dont certaines fonctions de fs.promises sont remplacées.
const withPromises = (overrides, sync = {}) => ({ ...fs, ...sync, promises: { ...fs.promises, ...overrides } });
// Fonction qui échoue (verrou) jusqu'à l'instant `until`, puis appelle la vraie.
const lockedUntil = (until, real, code = "EBUSY", counter = { n: 0 }) => async (...args) => {
  counter.n++;
  if (Date.now() < until) throw locked(code);
  return real(...args);
};

// ---------- Écriture asynchrone ----------

test("verrou passager (300 ms) sur le remplacement : réessayé, contenu exact, aucun temporaire", async () => {
  const dir = newDir("passager");
  const file = path.join(dir, "kora.json");
  fs.writeFileSync(file, JSON.stringify({ ancien: true }));
  const counter = { n: 0 };
  const fsImpl = withPromises({ rename: lockedUntil(Date.now() + 300, fs.promises.rename, "EPERM", counter) });
  await af.writeJsonAtomicAsync(file, { nouveau: "é ✨" }, { fsImpl, budgetMs: 3000 });
  assert.deepEqual(af.readJsonFile(file), { etat: "ok", valeur: { nouveau: "é ✨" } });
  assert.ok(counter.n > 1, "plusieurs tentatives");
  assert.deepEqual(af.leftoverTemps(dir), []);
});

test("verrou passager plus long que l'ancien budget (1,5 s) : l'écriture finit par réussir", async () => {
  const dir = newDir("passager-long");
  const file = path.join(dir, "kora.json");
  const fsImpl = withPromises({ rename: lockedUntil(Date.now() + 1500, fs.promises.rename) });
  await af.writeJsonAtomicAsync(file, { v: 1 }, { fsImpl, budgetMs: 4000 });
  assert.deepEqual(af.readJsonFile(file).valeur, { v: 1 });
  assert.deepEqual(af.leftoverTemps(dir), []);
});

test("verrou permanent : erreur 503 « réessayez » dans le budget, ancien fichier intact, temporaire retiré", async () => {
  const dir = newDir("permanent");
  const file = path.join(dir, "kora.json");
  fs.writeFileSync(file, JSON.stringify({ ancien: true }));
  const fsImpl = withPromises({ rename: async () => { throw locked("EPERM"); } });
  const t0 = Date.now();
  await assert.rejects(af.writeJsonAtomicAsync(file, { nouveau: true }, { fsImpl, budgetMs: 600 }), (err) => {
    assert.ok(err instanceof af.FileBusyError);
    assert.equal(err.status, 503);
    assert.ok(err.retryAfter > 0);
    assert.equal(err.code, undefined, "pas de code système exposé");
    return true;
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 500 && elapsed < 3000, `abandon après ${elapsed} ms`);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ ancien: true }));
  assert.deepEqual(af.leftoverTemps(dir), []);
});

test("verrou à la création du temporaire et à la relecture : réessayés aussi", async () => {
  const dir = newDir("etapes");
  const file = path.join(dir, "kora.json");
  const until = Date.now() + 250;
  const opens = { n: 0 };
  const fsImpl = withPromises(
    { open: lockedUntil(until, fs.promises.open, "EBUSY", opens) },
    { readFileSync: (p, ...rest) => { if (isTemp(p) && Date.now() < until + 250) throw locked("EPERM"); return fs.readFileSync(p, ...rest); } },
  );
  await af.writeJsonAtomicAsync(file, { v: 2 }, { fsImpl, budgetMs: 3000 });
  assert.deepEqual(af.readJsonFile(file).valeur, { v: 2 });
  assert.ok(opens.n > 1);
  assert.deepEqual(af.leftoverTemps(dir), []);
});

test("remplacement ET nettoyage refusés : le temporaire est laissé, signalé, et jamais supprimé ensuite", async () => {
  const dir = newDir("nettoyage");
  const file = path.join(dir, "kora.json");
  const fsImpl = withPromises({ rename: async () => { throw locked("EPERM"); }, rm: async () => { throw locked("EPERM"); }, unlink: async () => { throw locked("EPERM"); } });
  await assert.rejects(af.writeJsonAtomicAsync(file, { v: 1 }, { fsImpl, budgetMs: 300 }), af.FileBusyError);
  const left = af.leftoverTemps(dir);
  assert.equal(left.length, 1);
  await af.writeJsonAtomicAsync(file, { v: 2 }, { budgetMs: 300 });
  assert.deepEqual(af.leftoverTemps(dir), left, "l'ancien temporaire n'est pas supprimé automatiquement");
  assert.deepEqual(af.readJsonFile(file).valeur, { v: 2 });
});

test("une erreur qui n'est pas un verrou échoue tout de suite, sans attendre", async () => {
  const dir = newDir("eio");
  const file = path.join(dir, "kora.json");
  const counter = { n: 0 };
  const fsImpl = withPromises({ rename: async () => { counter.n++; throw locked("EIO"); } });
  const t0 = Date.now();
  await assert.rejects(af.writeJsonAtomicAsync(file, {}, { fsImpl, budgetMs: 5000 }), (err) => err.code === "EIO");
  assert.equal(counter.n, 1);
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(af.leftoverTemps(dir), []);
});

test("fichier en lecture seule : refus rapide (409), contenu et droits inchangés, aucun temporaire", async () => {
  const dir = newDir("lecture-seule");
  const file = path.join(dir, "kora.json");
  const content = JSON.stringify({ meta_token: "valeur-protegee" });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o444);
  const modeBefore = fs.statSync(file).mode;
  const t0 = Date.now();
  await assert.rejects(af.writeJsonAtomicAsync(file, { remplace: true }, { budgetMs: 5000 }), (err) => {
    assert.ok(err instanceof af.ReadOnlyFileError);
    assert.equal(err.status, 409);
    return true;
  });
  assert.ok(Date.now() - t0 < 1000, "sans attendre le budget de reprise");
  assert.equal(fs.readFileSync(file, "utf8"), content);
  assert.equal(fs.statSync(file).mode, modeBefore, "droits non modifiés");
  assert.deepEqual(af.leftoverTemps(dir), []);
});

test("fichier passé en lecture seule pendant l'écriture : refus 409 dès le remplacement refusé", async () => {
  const dir = newDir("lecture-seule-tardive");
  const file = path.join(dir, "kora.json");
  fs.writeFileSync(file, JSON.stringify({ ancien: true }));
  let renamed = false;
  const fsImpl = withPromises({
    rename: async () => { renamed = true; throw locked("EPERM"); },
    stat: async (p) => { const s = await fs.promises.stat(p); return renamed && p === file ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { mode: (s.mode & ~0o777) | 0o444 }) : s; },
  });
  const t0 = Date.now();
  await assert.rejects(af.writeJsonAtomicAsync(file, { v: 1 }, { fsImpl, budgetMs: 5000 }), af.ReadOnlyFileError);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ ancien: true }));
  assert.deepEqual(af.leftoverTemps(dir), []);
});

test("pendant une attente, le reste du programme continue de tourner", async () => {
  const dir = newDir("boucle");
  const file = path.join(dir, "kora.json");
  const fsImpl = withPromises({ rename: lockedUntil(Date.now() + 600, fs.promises.rename) });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    await af.writeJsonAtomicAsync(file, { v: 1 }, { fsImpl, budgetMs: 3000 });
  } finally { clearInterval(timer); }
  assert.ok(ticks >= 20, `${ticks} minuteries exécutées pendant l'attente`);
});

// ---------- Lecture ----------

test("lecture d'un fichier verrouillé : « verrouillé », pas « abîmé » ; reprise jusqu'à libération", async () => {
  const dir = newDir("lecture");
  const file = path.join(dir, "kora.json");
  fs.writeFileSync(file, JSON.stringify({ ok: 1 }));
  const lockedRead = (until) => ({ ...fs, readFileSync: (p, ...rest) => { if (p === file && Date.now() < until) throw locked("EBUSY"); return fs.readFileSync(p, ...rest); } });
  const r = af.readJsonFile(file, { fsImpl: lockedRead(Infinity) });
  assert.equal(r.etat, "illisible");
  assert.equal(r.erreur.diagnostic.categorie, "verrouille");
  assert.match(af.describeUnreadable(r.erreur), /verrouillé/);
  assert.deepEqual(await af.readJsonFileRetrying(file, { fsImpl: lockedRead(Date.now() + 300), budgetMs: 3000 }), { etat: "ok", valeur: { ok: 1 } });
  await assert.rejects(af.readJsonFileRetrying(file, { fsImpl: lockedRead(Infinity), budgetMs: 300 }), af.FileBusyError);
  // Un vrai fichier abîmé reste « illisible », sans attente.
  fs.writeFileSync(file, "{abîmé");
  const t0 = Date.now();
  const bad = await af.readJsonFileRetrying(file, { budgetMs: 5000 });
  assert.equal(bad.etat, "illisible");
  assert.equal(bad.erreur.diagnostic.categorie, "json_invalide");
  assert.ok(Date.now() - t0 < 1000);
});

// ---------- File d'attente par fichier ----------

test("20 lecture-modification-écriture concurrentes sur un même fichier : 20/20 conservées", async () => {
  const dir = newDir("concurrence");
  const file = path.join(dir, "liste.json");
  await af.writeJsonAtomicAsync(file, { items: [] });
  // Délais aléatoires pour mêler les étapes si la file d'attente ne fonctionnait pas.
  const fsImpl = withPromises({ rename: async (a, b) => { await sleep(Math.random() * 15); return fs.promises.rename(a, b); } });
  await Promise.all(Array.from({ length: 20 }, (_, i) => af.withFileLock(file, async () => {
    const cur = af.readJsonFile(file).valeur;
    await sleep(Math.random() * 5);
    cur.items.push(i);
    await af.writeJsonAtomicAsync(file, cur, { fsImpl });
  })));
  const final = af.readJsonFile(file);
  assert.equal(final.etat, "ok");
  assert.deepEqual([...final.valeur.items].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
  assert.deepEqual(af.leftoverTemps(dir), []);
});

test("file d'attente : une erreur ne bloque pas la suite ; les fichiers différents ne s'attendent pas", async () => {
  const dir = newDir("files");
  const a = path.join(dir, "a.json");
  const order = [];
  await assert.rejects(af.withFileLock(a, async () => { order.push(1); throw new Error("échec voulu"); }));
  await af.withFileLock(a, async () => order.push(2));
  assert.deepEqual(order, [1, 2]);

  // 5 fichiers × 10 écritures en parallèle, l'un d'eux verrouillé en permanence.
  const files = Array.from({ length: 5 }, (_, i) => path.join(dir, `m${i}.json`));
  const blocked = files[0];
  const fsImpl = withPromises({ rename: async (x, y) => { if (y === blocked) throw locked("EBUSY"); return fs.promises.rename(x, y); } });
  for (const f of files.slice(1)) await af.writeJsonAtomicAsync(f, { items: [] });
  const done = {};
  const t0 = Date.now();
  const jobs = files.flatMap((f) => Array.from({ length: 10 }, (_, i) => af.withFileLock(f, async () => {
    const cur = af.readJsonFile(f).valeur || { items: [] };
    cur.items.push(i);
    await af.writeJsonAtomicAsync(f, cur, { fsImpl, budgetMs: 400 });
  }).then(() => { done[f] = Date.now() - t0; }, () => {})));
  await Promise.all(jobs);
  for (const f of files.slice(1)) {
    assert.equal(af.readJsonFile(f).valeur.items.length, 10, path.basename(f));
    assert.ok(done[f] < 1500, `${path.basename(f)} n'a pas attendu le fichier verrouillé (${done[f]} ms)`);
  }
  assert.equal(af.readJsonFile(blocked).etat, "absent", "le fichier verrouillé n'a jamais été remplacé à moitié");
  assert.deepEqual(af.leftoverTemps(dir), []);
});

// ---------- Serveur complet (verrous simulés par un module préchargé) ----------

// Tant que le fichier « marqueur » existe, les remplacements, lectures ou
// effacements du fichier visé échouent comme sous Windows quand un antivirus le tient.
const PRELOAD = `
import fs from "node:fs";
const target = process.env.TEST_LOCK_TARGET;
const busy = (marker) => marker && fs.existsSync(marker);
const realRename = fs.promises.rename;
fs.promises.rename = async (a, b) => {
  if (String(b).endsWith(target) && busy(process.env.TEST_LOCK_WRITE)) throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
  return realRename(a, b);
};
const realRead = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (typeof p === "string" && p.endsWith(target) && busy(process.env.TEST_LOCK_READ)) throw Object.assign(new Error("EBUSY: resource busy or locked, open"), { code: "EBUSY" });
  return realRead.call(this, p, ...rest);
};
const deleting = (p) => String(p).endsWith(target) && busy(process.env.TEST_LOCK_DELETE);
const lockedDelete = () => Object.assign(new Error("EBUSY: resource busy or locked, unlink"), { code: "EBUSY" });
for (const name of ["unlink", "rm"]) {
  const real = fs.promises[name];
  fs.promises[name] = async (p, ...rest) => { if (deleting(p)) throw lockedDelete(); return real(p, ...rest); };
}
for (const name of ["unlinkSync", "rmSync"]) {
  const real = fs[name];
  fs[name] = function (p, ...rest) { if (deleting(p)) throw lockedDelete(); return real.call(this, p, ...rest); };
}
`;

async function startServer() {
  const runtime = newDir("rt");
  const secrets = newDir("sec");
  const sauvegardes = newDir("sauvegardes"); // sauvegardes de droits (2b.4) propres à ce serveur
  const ctl = newDir("ctl");
  const preload = path.join(ctl, "verrous.mjs");
  fs.writeFileSync(preload, PRELOAD);
  const lockWrite = path.join(ctl, "verrou-ecriture");
  const lockRead = path.join(ctl, "verrou-lecture");
  const lockDelete = path.join(ctl, "verrou-effacement");
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "server.js"], {
    cwd: root,
    env: {
      ...process.env, PORT: "0", JURGENITA_DEMO: "1", JURGENITA_NO_SCHEDULER: "1",
      JURGENITA_RUNTIME_DIR: runtime, JURGENITA_SECRETS_DIR: secrets, JURGENITA_SECRETS_BACKUP_DIR: sauvegardes,
      TEST_LOCK_TARGET: `${path.sep}kora.json`, TEST_LOCK_WRITE: lockWrite, TEST_LOCK_READ: lockRead, TEST_LOCK_DELETE: lockDelete,
      META_ACCESS_TOKEN: "", TIKTOK_ACCESS_TOKEN: "", LINKEDIN_ACCESS_TOKEN: "", TELEGRAM_BOT_TOKEN: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "",
    },
  });
  let logs = "";
  child.stdout.on("data", (c) => (logs += c));
  child.stderr.on("data", (c) => (logs += c));
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", () => { const m = logs.match(/http:\/\/[\d.]+:(\d+)/); if (m) resolve(Number(m[1])); });
    child.on("exit", (code) => reject(new Error(`serveur arrêté (code ${code}) :\n${logs}`)));
  });
  const secretFile = path.join(secrets, "brands", "kora.json");
  return {
    port, secretFile, logs: () => logs, stop: () => child.kill(),
    lockWrite: () => fs.writeFileSync(lockWrite, ""), unlockWrite: () => fs.rmSync(lockWrite, { force: true }),
    lockRead: () => fs.writeFileSync(lockRead, ""), unlockRead: () => fs.rmSync(lockRead, { force: true }),
    lockDelete: () => fs.writeFileSync(lockDelete, ""), unlockDelete: () => fs.rmSync(lockDelete, { force: true }),
  };
}

function call(port, method, p, body, brand = "kora") {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "content-type": "application/json", ...(brand ? { "x-marque": brand } : {}) } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let json = null; try { json = JSON.parse(d); } catch { /* */ } resolve({ status: res.statusCode, headers: res.headers, body: json, text: d, ms: Date.now() - t0 }); });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const put = (srv, values, brand) => call(srv.port, "PUT", "/api/brand/connexions", values, brand);

test("serveur : verrou passager pendant un enregistrement → les autres routes répondent, puis 200 et contenu exact", async () => {
  const srv = await startServer();
  try {
    assert.equal((await put(srv, { meta_page_id: "page-1" })).status, 200);
    srv.lockWrite();
    let settled = false;
    const pending = put(srv, { linkedin_org_id: "org-2" }).finally(() => { settled = true; });
    await sleep(400);
    const status = await call(srv.port, "GET", "/api/status");
    const inbox = await call(srv.port, "GET", "/api/data/inbox");
    assert.equal(status.status, 200);
    assert.equal(inbox.status, 200);
    assert.ok(status.ms < 1000 && inbox.ms < 1000, `réponses en ${status.ms} et ${inbox.ms} ms pendant l'attente`);
    assert.equal(settled, false, "l'enregistrement attend toujours le verrou");
    srv.unlockWrite();
    const res = await pending;
    assert.equal(res.status, 200, res.text);
    const saved = JSON.parse(fs.readFileSync(srv.secretFile, "utf8"));
    assert.equal(saved.meta_page_id, "page-1");
    assert.equal(saved.linkedin_org_id, "org-2");
    assert.deepEqual(af.leftoverTemps(path.dirname(srv.secretFile)), []);
  } finally { srv.unlockWrite(); srv.stop(); }
});

test("serveur : verrou persistant → 503 avec Retry-After, message clair, fichier inchangé, aucun secret affiché", async () => {
  const srv = await startServer();
  try {
    assert.equal((await put(srv, { tiktok_token: "tkQz81Lm4Xw7Pc2VbN6dR3" })).status, 200);
    const before = fs.readFileSync(srv.secretFile, "utf8");
    srv.lockWrite();
    const res = await put(srv, { tiktok_token: "tkNouveauW8e2Rt5Yu1Io9" });
    assert.equal(res.status, 503, res.text);
    assert.ok(Number(res.headers["retry-after"]) > 0, "en-tête Retry-After");
    assert.match(res.body.erreur, /verrouillé/i);
    assert.match(res.body.erreur, /réessayez/i);
    assert.ok(!/kora\.json|[\\/]/.test(res.body.erreur), "pas de chemin dans le message");
    assert.equal(fs.readFileSync(srv.secretFile, "utf8"), before);
    srv.unlockWrite();
    await sleep(100);
    for (const t of ["tkQz81Lm4Xw7Pc2VbN6dR3", "tkNouveauW8e2Rt5Yu1Io9"]) assert.ok(!srv.logs().includes(t) && !res.text.includes(t), "aucun jeton affiché");
  } finally { srv.unlockWrite(); srv.stop(); }
});

test("serveur : fichier valide mais verrouillé en lecture → 503 (pas le 409 « abîmé »), sans message de corruption", async () => {
  const srv = await startServer();
  try {
    assert.equal((await put(srv, { meta_page_id: "page-1" })).status, 200);
    srv.lockRead();
    const res = await put(srv, { meta_page_id: "page-2" });
    srv.unlockRead();
    assert.equal(res.status, 503, res.text);
    assert.ok(Number(res.headers["retry-after"]) > 0);
    assert.doesNotMatch(res.body.erreur, /illisible|retirez/i);
    assert.doesNotMatch(srv.logs(), /illisible/i, "pas signalé comme abîmé");
    assert.equal(JSON.parse(fs.readFileSync(srv.secretFile, "utf8")).meta_page_id, "page-1");
    // Un vrai fichier abîmé garde son 409.
    fs.writeFileSync(srv.secretFile, "{abîmé");
    const corrupt = await put(srv, { meta_page_id: "page-3" });
    assert.equal(corrupt.status, 409);
    assert.match(corrupt.body.erreur, /illisibles/);
  } finally { srv.unlockRead(); srv.stop(); }
});

test("serveur : fichier en lecture seule → 409 rapide, contenu et droits conservés", async () => {
  const srv = await startServer();
  try {
    assert.equal((await put(srv, { meta_page_id: "page-1" })).status, 200);
    fs.chmodSync(srv.secretFile, 0o444);
    const before = fs.readFileSync(srv.secretFile, "utf8");
    const mode = fs.statSync(srv.secretFile).mode;
    const res = await put(srv, { meta_page_id: "page-2" });
    assert.equal(res.status, 409, res.text);
    assert.match(res.body.erreur, /lecture seule/);
    assert.ok(res.ms < 2000, `réponse en ${res.ms} ms`);
    assert.equal(fs.readFileSync(srv.secretFile, "utf8"), before);
    assert.equal(fs.statSync(srv.secretFile).mode, mode);
    assert.deepEqual(af.leftoverTemps(path.dirname(srv.secretFile)), []);
  } finally { try { fs.chmodSync(srv.secretFile, 0o600); } catch { /* */ } srv.stop(); }
});

test("serveur : 20 enregistrements concurrents (pendant un verrou) → aucune mise à jour perdue ; un seul lien de validation", async () => {
  const srv = await startServer();
  try {
    const fields = ["meta_ig_user_id", "meta_page_id", "meta_ad_account_id", "google_business_location", "linkedin_org_id"];
    srv.lockWrite();
    const jobs = Array.from({ length: 20 }, (_, i) => put(srv, { [fields[i % fields.length]]: `valeur-${i}` }));
    await sleep(300);
    srv.unlockWrite();
    const results = await Promise.all(jobs);
    assert.deepEqual(results.map((r) => r.status), Array(20).fill(200));
    const saved = JSON.parse(fs.readFileSync(srv.secretFile, "utf8"));
    for (const f of fields) assert.ok(saved[f], `champ ${f} conservé`);
    const links = await Promise.all(Array.from({ length: 20 }, () => call(srv.port, "POST", "/api/brand/validation-link", {})));
    assert.equal(new Set(links.map((r) => r.body.chemin)).size, 1, "un seul lien généré");
    const after = JSON.parse(fs.readFileSync(srv.secretFile, "utf8"));
    for (const f of fields) assert.equal(after[f], saved[f], "le lien n'a rien effacé");
    assert.deepEqual(af.leftoverTemps(path.dirname(srv.secretFile)), []);
  } finally { srv.unlockWrite(); srv.stop(); }
});

test("serveur : deux marques enregistrées en même temps, sans interférence", async () => {
  const srv = await startServer();
  try {
    const jobs = ["kora", "resto-afrik"].flatMap((brand) => ["meta_ig_user_id", "meta_page_id", "linkedin_org_id"].map((f) => put(srv, { [f]: `${brand}-${f}` }, brand)));
    assert.deepEqual((await Promise.all(jobs)).map((r) => r.status), Array(6).fill(200));
    for (const brand of ["kora", "resto-afrik"]) {
      const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(srv.secretFile), `${brand}.json`), "utf8"));
      assert.deepEqual(saved, { meta_ig_user_id: `${brand}-meta_ig_user_id`, meta_page_id: `${brand}-meta_page_id`, linkedin_org_id: `${brand}-linkedin_org_id` });
    }
  } finally { srv.stop(); }
});

// ---------- Suppression d'une marque et file d'attente (correctif 2b.3) ----------
// Une suppression ne doit jamais laisser de fichier d'accès orphelin, ni
// laisser une opération en attente le recréer, ni le faire hériter à une
// marque recréée sous le même identifiant.

// Sans en-tête de marque (marque par défaut) : la marque visée peut ne plus exister.
const del = (srv, id = "kora") => call(srv.port, "POST", "/api/brands/delete", { id }, null);
const brandIds = async (srv) => (await call(srv.port, "GET", "/api/data/brands", null, null)).body.map((b) => b.id);
const fieldsOf = async (srv, brand) => (await call(srv.port, "GET", "/api/status", null, brand)).body.connexions.marque.champs_renseignes;

test("suppression pendant un saveConfig en attente : l'enregistrement passe d'abord, puis la marque et ses accès disparaissent", async () => {
  const srv = await startServer();
  try {
    assert.equal((await put(srv, { tiktok_token: "tkQz81Lm4Xw7Pc2VbN6dR3" })).status, 200);
    srv.lockWrite();
    const pending = put(srv, { linkedin_token: "liWp52Hs9Ke3Gd7Tq4Mz8" });
    await sleep(300);
    const deletion = del(srv);
    await sleep(300);
    srv.unlockWrite();
    const [save, removed] = await Promise.all([pending, deletion]);
    assert.equal(save.status, 200, save.text);
    assert.equal(removed.status, 200, removed.text);
    assert.ok(!(await brandIds(srv)).includes("kora"), "marque supprimée");
    assert.equal(fs.existsSync(srv.secretFile), false, "aucun fichier d'accès orphelin recréé");
    assert.deepEqual(af.leftoverTemps(path.dirname(srv.secretFile)), []);
  } finally { srv.unlockWrite(); srv.stop(); }
});

test("suppression pendant un validationToken en attente : aucun fichier d'accès orphelin", async () => {
  const srv = await startServer();
  try {
    assert.equal((await put(srv, { meta_page_id: "page-1" })).status, 200);
    srv.lockWrite();
    const link = call(srv.port, "POST", "/api/brand/validation-link", {});
    await sleep(300);
    const deletion = del(srv);
    await sleep(300);
    srv.unlockWrite();
    const [linkRes, removed] = await Promise.all([link, deletion]);
    assert.equal(linkRes.status, 200, linkRes.text);
    assert.equal(removed.status, 200, removed.text);
    assert.ok(!(await brandIds(srv)).includes("kora"));
    assert.equal(fs.existsSync(srv.secretFile), false, "aucun fichier d'accès orphelin recréé");
  } finally { srv.unlockWrite(); srv.stop(); }
});

test("écriture lancée après la suppression : 404, aucun fichier recréé", async () => {
  const srv = await startServer();
  try {
    assert.equal((await put(srv, { meta_page_id: "page-1" })).status, 200);
    // a) Lancées pendant que la suppression attend (effacement verrouillé).
    srv.lockDelete();
    const deletion = del(srv);
    await sleep(300);
    const lateSave = put(srv, { meta_page_id: "tardif" });
    const lateLink = call(srv.port, "POST", "/api/brand/validation-link", {});
    await sleep(300);
    srv.unlockDelete();
    const [removed, save, link] = await Promise.all([deletion, lateSave, lateLink]);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(save.status, 404, save.text);
    assert.equal(link.status, 404, link.text);
    assert.equal(fs.existsSync(srv.secretFile), false);
    // b) Lancées une fois la suppression terminée.
    assert.equal((await put(srv, { meta_page_id: "apres" })).status, 404);
    assert.equal((await call(srv.port, "POST", "/api/brand/validation-link", {})).status, 404);
    assert.equal(fs.existsSync(srv.secretFile), false, "aucun fichier recréé");
    assert.deepEqual(af.leftoverTemps(path.dirname(srv.secretFile)), []);
  } finally { srv.unlockDelete(); srv.stop(); }
});

test("suppression bloquée par un verrou persistant : 503 + Retry-After, marque et accès conservés ; réessai après libération", async () => {
  const srv = await startServer();
  try {
    assert.equal((await put(srv, { tiktok_token: "tkQz81Lm4Xw7Pc2VbN6dR3", meta_page_id: "page-1" })).status, 200);
    const before = fs.readFileSync(srv.secretFile, "utf8");
    srv.lockDelete();
    const res = await del(srv);
    srv.unlockDelete();
    assert.equal(res.status, 503, res.text);
    assert.ok(Number(res.headers["retry-after"]) > 0, "en-tête Retry-After");
    assert.match(res.body.erreur, /verrouill/i);
    assert.match(res.body.erreur, /conservée/);
    assert.ok(!res.text.includes("tkQz81"), "aucun jeton dans la réponse");
    assert.ok((await brandIds(srv)).includes("kora"), "la marque reste dans la liste");
    assert.equal(fs.readFileSync(srv.secretFile, "utf8"), before, "ses accès sont intacts");
    assert.deepEqual((await fieldsOf(srv, "kora")).sort(), ["meta_page_id", "tiktok_token"]);
    const again = await del(srv);
    assert.equal(again.status, 200, again.text);
    assert.equal(fs.existsSync(srv.secretFile), false);
    assert.ok(!(await brandIds(srv)).includes("kora"));
  } finally { srv.unlockDelete(); srv.stop(); }
});

test("suppression d'une marque dont le fichier d'accès est en lecture seule : 409, rien n'est supprimé", async () => {
  const srv = await startServer();
  try {
    assert.equal((await put(srv, { meta_page_id: "page-1" })).status, 200);
    fs.chmodSync(srv.secretFile, 0o444);
    const before = fs.readFileSync(srv.secretFile, "utf8");
    const mode = fs.statSync(srv.secretFile).mode;
    const res = await del(srv);
    assert.equal(res.status, 409, res.text);
    assert.match(res.body.erreur, /lecture seule/);
    assert.ok((await brandIds(srv)).includes("kora"));
    assert.equal(fs.readFileSync(srv.secretFile, "utf8"), before);
    assert.equal(fs.statSync(srv.secretFile).mode, mode, "droits non modifiés");
  } finally { try { fs.chmodSync(srv.secretFile, 0o600); } catch { /* */ } srv.stop(); }
});

test("marque recréée avec le même identifiant : aucun ancien accès ; un fichier orphelin existant n'est ni réattribué ni supprimé", async () => {
  const srv = await startServer();
  try {
    assert.equal((await put(srv, { tiktok_token: "tkQz81Lm4Xw7Pc2VbN6dR3", linkedin_org_id: "org-1" })).status, 200);
    assert.equal((await del(srv)).status, 200);
    const recreated = await call(srv.port, "POST", "/api/brands", { nom: "Kora" }, null);
    assert.equal(recreated.status, 200, recreated.text);
    assert.equal(recreated.body.id, "kora", "même identifiant");
    assert.deepEqual(await fieldsOf(srv, "kora"), [], "aucun ancien accès récupéré");
    assert.equal(fs.existsSync(srv.secretFile), false);

    // Fichier orphelin déjà présent (laissé par une version antérieure) :
    // la nouvelle marque prend un autre identifiant, l'orphelin reste intact.
    const orphan = path.join(path.dirname(srv.secretFile), "nouvelle.json");
    const orphanContent = JSON.stringify({ tiktok_token: "tkOrphelinH7j2K9m4N1p" });
    fs.writeFileSync(orphan, orphanContent);
    const created = await call(srv.port, "POST", "/api/brands", { nom: "Nouvelle" }, null);
    assert.equal(created.status, 200, created.text);
    assert.notEqual(created.body.id, "nouvelle", "l'identifiant de l'orphelin n'est pas réutilisé");
    assert.deepEqual(await fieldsOf(srv, created.body.id), []);
    assert.equal(fs.readFileSync(orphan, "utf8"), orphanContent, "l'orphelin n'est ni modifié ni supprimé");
  } finally { srv.stop(); }
});

test("deux suppressions simultanées des deux dernières marques : une seule aboutit, il reste une marque", async () => {
  const srv = await startServer();
  try {
    srv.lockDelete(); // ralentit la suppression de kora pour que les deux se chevauchent
    const first = del(srv, "kora");
    await sleep(300);
    const second = del(srv, "resto-afrik");
    await sleep(300);
    srv.unlockDelete();
    const statuses = (await Promise.all([first, second])).map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 400]);
    assert.equal((await brandIds(srv)).length, 1, "il reste toujours une marque");
  } finally { srv.unlockDelete(); srv.stop(); }
});

// ---------- Masquage des journaux pendant un verrou (TikTok, LinkedIn) ----------

// Jetons factices sans forme reconnaissable : seuls les valeurs exactes connues
// permettent de les masquer (aucun motif ne les attrape).
const TIKTOK = "tkQz81Lm4Xw7Pc2VbN6dR3";
const LINKEDIN = "liWp52Hs9Ke3Gd7Tq4Mz8";
const MASKING_SCRIPT = `
import fs from "node:fs";
const redaction = await import(process.env.REDACT_URL);
const brands = await import(process.env.BRANDS_URL);
redaction.installConsoleRedaction();
// Même source de masquage que server.js (repli sur l'ancienne si la fonction n'existe pas).
redaction.addSecretSource(() => brands.secretsForRedaction ? brands.secretsForRedaction() : brands.list().flatMap((b) => { const c = brands.config(b.id); return [c.meta.token, c.tiktok.token, c.linkedin.token]; }));
const file = process.env.SECRET_FILE;
const out = {};
const step = async (name) => { process.stdout.write("@@" + name + "\\n"); await new Promise((r) => process.stdin.once("data", r)); };
console.log("A", process.env.T1, process.env.T2);
await step("verrouiller");
console.log("B", process.env.T1, process.env.T2);
const c = brands.config("kora");
out.configPendantVerrou = { tiktok: c.tiktok.token, linkedin: c.linkedin.token };
out.statutPendantVerrou = JSON.stringify(brands.connectionStatus("kora"));
await step("liberer");
fs.writeFileSync(file, "{abîmé");
console.log("C", process.env.T1, process.env.T2);
fs.writeFileSync(file, JSON.stringify({ tiktok_token: "tkNouveauW8e2Rt5Yu1Io9" }));
console.log("D", "tkNouveauW8e2Rt5Yu1Io9");
fs.rmSync(file);
out.cacheVideApresSuppression = brands.secretsForRedaction ? !brands.secretsForRedaction().includes("tkNouveauW8e2Rt5Yu1Io9") : null;
process.stdout.write("@@resultat " + JSON.stringify(out) + "\\n");
`;

// Lance le script de masquage ; `lock`/`unlock` posent et lèvent le verrou
// (simulé ici, réel sous Windows dans windows.test.js).
async function runMaskingScenario({ preload, lock, unlock, secrets, runtime, sauvegardes, env = {} }) {
  const file = path.join(secrets, "brands", "kora.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tiktok_token: TIKTOK, linkedin_token: LINKEDIN, linkedin_org_id: "org-1" }));
  const args = [...(preload ? ["--import", pathToFileURL(preload).href] : []), "--input-type=module", "-e", MASKING_SCRIPT];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env, REDACT_URL: srcUrl("redact.js"), BRANDS_URL: srcUrl("brands.js"), SECRET_FILE: file, T1: TIKTOK, T2: LINKEDIN,
      JURGENITA_SECRETS_DIR: secrets, JURGENITA_SECRETS_BACKUP_DIR: sauvegardes, JURGENITA_RUNTIME_DIR: runtime, TIKTOK_ACCESS_TOKEN: "", LINKEDIN_ACCESS_TOKEN: "", META_ACCESS_TOKEN: "" },
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const done = new Promise((resolve) => child.on("exit", resolve));
  const handled = new Set();
  await new Promise((resolve, reject) => {
    child.stdout.on("data", async (c) => {
      stdout += c;
      try {
        for (const [marker, action] of [["@@verrouiller\n", lock], ["@@liberer\n", unlock]]) {
          if (stdout.includes(marker) && !handled.has(marker)) { handled.add(marker); await action(file); child.stdin.write("ok\n"); }
        }
        if (/@@resultat .*\n/.test(stdout)) { child.stdin.end(); resolve(); }
      } catch (e) { reject(e); }
    });
    child.on("exit", () => resolve());
  });
  await done;
  const result = /@@resultat (.*)/.exec(stdout);
  return { stdout, stderr, result: result ? JSON.parse(result[1]) : null };
}

function assertMasked({ stdout, stderr, result }) {
  const logs = stdout + stderr;
  assert.ok(result, `le scénario est allé au bout :\n${logs}`);
  for (const line of ["A", "B", "C", "D"]) assert.match(stdout, new RegExp(`^${line} \\[masqué\\]`, "m"), `ligne ${line} masquée`);
  for (const t of [TIKTOK, LINKEDIN, "tkNouveauW8e2Rt5Yu1Io9"]) {
    for (let i = 0; i + 6 <= t.length; i++) assert.ok(!logs.includes(t.slice(i, i + 6)), `fragment « ${t.slice(i, i + 6)} » dans le journal :\n${logs}`);
  }
  assert.deepEqual(result.configPendantVerrou, { tiktok: "", linkedin: "" }, "le cache ne sert jamais aux connecteurs");
  assert.ok(!result.statutPendantVerrou.includes(TIKTOK.slice(0, 6)) && !result.statutPendantVerrou.includes(LINKEDIN.slice(0, 6)), "rien d'exposé dans l'état des connexions");
  assert.equal(result.cacheVideApresSuppression, true, "fichier absent : cache vidé");
}

test("masquage : jetons TikTok et LinkedIn toujours masqués pendant un verrou de lecture (simulé)", async () => {
  const ctl = newDir("masque-ctl");
  const preload = path.join(ctl, "verrous.mjs");
  fs.writeFileSync(preload, PRELOAD);
  const marker = path.join(ctl, "verrou-lecture");
  const run = await runMaskingScenario({
    preload, secrets: newDir("masque-sec"), runtime: newDir("masque-rt"), sauvegardes: newDir("masque-sauvegardes"),
    env: { TEST_LOCK_TARGET: `${path.sep}kora.json`, TEST_LOCK_READ: marker },
    lock: () => fs.writeFileSync(marker, ""), unlock: () => fs.rmSync(marker, { force: true }),
  });
  assertMasked(run);
});
