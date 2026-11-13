// Sous-étape 2a : stockage des accès des marques.
// - un fichier absent n'est pas un fichier illisible ;
// - un fichier illisible n'est jamais écrasé ;
// - les écritures sont atomiques et vérifiées, y compris en cas d'arrêt forcé.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonFile, writeJsonAtomic, leftoverTemps, TEMP_SUFFIX } from "../src/atomic-file.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Adresse file:// d'un module de src/, utilisable dans import() sous Windows comme ailleurs
// (un chemin absolu « C:\… » y est refusé).
const srcUrl = (...parts) => pathToFileURL(path.join(root, "src", ...parts)).href;
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `jurgenita-2a-${name}-`));
const dirs = [];
const newDir = (name) => { const d = tmp(name); dirs.push(d); return d; };
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// ---------- Lecture : absent / correct / illisible ----------

test("lecture : un fichier absent n'est pas un fichier illisible", () => {
  const dir = newDir("lecture");
  assert.deepEqual(readJsonFile(path.join(dir, "rien.json")), { etat: "absent" });
  fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ a: 1, b: "é ✨" }));
  assert.deepEqual(readJsonFile(path.join(dir, "ok.json")), { etat: "ok", valeur: { a: 1, b: "é ✨" } });
  for (const [name, content] of [["tronque", "{\"meta_token\": \"EAA"], ["vide", ""], ["binaire", "\u0000\u0001\u0002"], ["tableau", "[1,2]"], ["nul", "null"], ["nombre", "42"]]) {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, content);
    const r = readJsonFile(file);
    assert.equal(r.etat, "illisible", name);
    assert.ok(!r.erreur.message.includes("EAA"), "le message ne recopie pas le contenu");
  }
  // Un dossier à la place du fichier (erreur d'accès autre que « absent »).
  fs.mkdirSync(path.join(dir, "dossier.json"));
  assert.equal(readJsonFile(path.join(dir, "dossier.json")).etat, "illisible");
});

// ---------- Écriture atomique et vérifiée ----------

test("écriture : contenu exact, permissions 600, aucun fichier temporaire laissé", () => {
  const dir = newDir("ecriture");
  const file = path.join(dir, "kora.json");
  const value = { meta_token: "jeton-factice", note: "accents é à ✨", n: 3 };
  writeJsonAtomic(file, value);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), value);
  if (process.platform !== "win32") assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  assert.deepEqual(leftoverTemps(dir), []);
  writeJsonAtomic(file, { remplace: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { remplace: true });
  assert.deepEqual(leftoverTemps(dir), []);
});

// Système de fichiers simulé : un vrai fs, avec une panne injectée à une étape.
function faultyFs(step) {
  return {
    ...fs,
    writeFileSync: (fd, text, enc) => (step === "ecriture-tronquee" ? fs.writeFileSync(fd, text.slice(0, 10), enc) : fs.writeFileSync(fd, text, enc)),
    fsyncSync: (fd) => { if (step === "fsync") throw Object.assign(new Error("panne disque"), { code: "EIO" }); return fs.fsyncSync(fd); },
    renameSync: (a, b) => { if (step === "rename") throw Object.assign(new Error("remplacement impossible"), { code: "EXDEV" }); return fs.renameSync(a, b); },
  };
}

test("écriture : une panne à n'importe quelle étape laisse l'ancien fichier intact", () => {
  const dir = newDir("pannes");
  const file = path.join(dir, "kora.json");
  writeJsonAtomic(file, { meta_token: "ancien" });
  const before = fs.readFileSync(file);
  for (const step of ["ecriture-tronquee", "fsync", "rename"]) {
    assert.throws(() => writeJsonAtomic(file, { meta_token: "nouveau" }, { fsImpl: faultyFs(step) }), step);
    assert.deepEqual(fs.readFileSync(file), before, `${step} : fichier inchangé octet pour octet`);
    assert.deepEqual(leftoverTemps(dir), [], `${step} : fichier temporaire retiré`);
  }
});

test("écriture : un verrou passager (Windows, antivirus) est réessayé", () => {
  const dir = newDir("verrou");
  const file = path.join(dir, "kora.json");
  let failures = 2;
  const lockedFs = { ...fs, renameSync: (a, b) => { if (failures-- > 0) throw Object.assign(new Error("verrouillé"), { code: "EPERM" }); return fs.renameSync(a, b); } };
  writeJsonAtomic(file, { ok: true }, { fsImpl: lockedFs });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ok: true });
});

test("arrêt forcé pendant des écritures : le fichier contient toujours une version complète", async () => {
  const dir = newDir("arret-force");
  const file = path.join(dir, "kora.json");
  const versionA = { meta_token: "A".repeat(5000), version: "A" };
  const versionB = { meta_token: "B".repeat(5000), version: "B" };
  writeJsonAtomic(file, versionA);
  const script = `
    import { writeJsonAtomic } from ${JSON.stringify(srcUrl("atomic-file.js"))};
    const a = ${JSON.stringify(versionA)}, b = ${JSON.stringify(versionB)};
    process.stdout.write("pret\\n");
    for (let i = 0; ; i++) writeJsonAtomic(${JSON.stringify(file)}, i % 2 ? a : b);
  `;
  for (let round = 0; round < 25; round++) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
    await new Promise((resolve) => child.stdout.once("data", resolve));
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 40));
    child.kill("SIGKILL"); // équivalent d'un arrêt forcé : aucun nettoyage possible
    await new Promise((resolve) => child.on("exit", resolve));
    const r = readJsonFile(file);
    assert.equal(r.etat, "ok", `tour ${round} : fichier lisible`);
    assert.ok(["A", "B"].includes(r.valeur.version) && r.valeur.meta_token === r.valeur.version.repeat(5000), `tour ${round} : version complète`);
  }
  // Les éventuels temporaires laissés par l'arrêt sont ignorés et seulement signalés.
  for (const name of leftoverTemps(dir)) assert.ok(name.endsWith(TEMP_SUFFIX));
});

// ---------- Module des marques ----------

test("marques : un fichier illisible n'est jamais écrasé, les autres marques fonctionnent", () => {
  const runtime = newDir("runtime");
  const secrets = newDir("secrets");
  const script = `
    const brands = await import(${JSON.stringify(srcUrl("brands.js"))});
    const fs = await import("node:fs");
    const file = ${JSON.stringify(path.join(secrets, "brands", "kora.json"))};
    const out = {};
    // 1. Absent : aucun accès, écriture permise.
    out.absent = brands.connectionStatus("kora");
    await brands.saveConfig("kora", { meta_token: "jeton-factice-kora", meta_page_id: "42" });
    out.apresEcriture = brands.connectionStatus("kora");
    // 2. Fichier abîmé (coupure pendant une ancienne écriture non atomique).
    fs.writeFileSync(file, '{ "meta_token": "jeton-factice-kora", "meta_page');
    const avant = fs.readFileSync(file, "utf8");
    out.illisible = brands.connectionStatus("kora");
    out.config = brands.config("kora").meta;
    for (const [nom, action] of [
      ["saveConfig", () => brands.saveConfig("kora", { tiktok_token: "nouveau-jeton" })],
      ["saveConfig vide", () => brands.saveConfig("kora", {})],
      ["validationToken", () => brands.validationToken("kora")],
    ]) {
      try { await action(); out[nom] = "accepté"; } catch (e) { out[nom] = [e.status, e.name]; }
    }
    out.inchange = fs.readFileSync(file, "utf8") === avant;
    out.parJeton = brands.brandByValidationToken("x".repeat(24));
    // 3. L'autre marque n'est pas touchée.
    await brands.saveConfig("resto-afrik", { linkedin_token: "jeton-factice-resto", linkedin_org_id: "7" });
    out.autre = brands.connectionStatus("resto-afrik");
    const lien = await brands.validationToken("resto-afrik");
    out.lienAutre = brands.brandByValidationToken(lien)?.id;
    out.sante = brands.secretsHealth();
    process.stdout.write(JSON.stringify(out));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, JURGENITA_RUNTIME_DIR: runtime, JURGENITA_SECRETS_DIR: secrets, META_ACCESS_TOKEN: "", META_PAGE_ID: "", META_IG_USER_ID: "", LINKEDIN_ACCESS_TOKEN: "", LINKEDIN_ORG_ID: "" },
  });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.absent.acces_illisibles, false);
  assert.equal(out.absent.meta, false);
  assert.equal(out.apresEcriture.meta, true);
  assert.equal(out.illisible.acces_illisibles, true);
  assert.deepEqual(out.illisible.champs_renseignes, []);
  assert.equal(out.config.token, "", "un fichier illisible donne des accès vides, sans planter");
  assert.deepEqual(out.saveConfig, [409, "UnreadableSecretsError"]);
  assert.deepEqual(out["saveConfig vide"], [409, "UnreadableSecretsError"]);
  assert.deepEqual(out.validationToken, [409, "UnreadableSecretsError"]);
  assert.equal(out.inchange, true, "le fichier illisible est resté identique");
  assert.equal(out.parJeton, null);
  assert.equal(out.autre.meta, false);
  assert.equal(out.autre.linkedin, true, "l'autre marque s'enregistre normalement");
  assert.equal(out.lienAutre, "resto-afrik", "les liens clients des autres marques fonctionnent");
  assert.deepEqual(out.sante, { illisibles: ["kora"], fichiers_temporaires: 0 });
  assert.equal((run.stderr.match(/Fichier illisible/g) || []).length, 1, "signalé une seule fois dans le journal");
  assert.ok(!/jeton-factice/.test(run.stderr), "le journal ne recopie pas le contenu");
});

// ---------- Serveur complet ----------

test("serveur : démarre avec un fichier d'accès abîmé, refuse de l'écraser (409) et reste utilisable", async () => {
  const runtime = newDir("srv-runtime");
  const secrets = newDir("srv-secrets");
  fs.mkdirSync(path.join(secrets, "brands"), { recursive: true });
  const broken = path.join(secrets, "brands", "kora.json");
  fs.writeFileSync(broken, "{ tronqué");
  fs.writeFileSync(path.join(secrets, "brands", `.kora.json.abc123${TEMP_SUFFIX}`), "{ reste d'une écriture interrompue");
  const before = fs.readFileSync(broken);
  const server = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, PORT: "0", JURGENITA_DEMO: "1", JURGENITA_NO_SCHEDULER: "1", JURGENITA_RUNTIME_DIR: runtime, JURGENITA_SECRETS_DIR: secrets, META_ACCESS_TOKEN: "", TELEGRAM_BOT_TOKEN: "" },
  });
  let logs = "";
  server.stderr.on("data", (c) => (logs += c));
  server.stdout.on("data", (c) => (logs += c));
  try {
    const port = await new Promise((resolve, reject) => {
      server.stdout.on("data", (c) => { const m = String(c).match(/:(\d+)\n/); if (m) resolve(Number(m[1])); });
      server.on("exit", (code) => reject(new Error(`arrêt du serveur (code ${code}) :\n${logs.slice(0, 500)}`)));
    });
    const call = (method, p, body, brand) => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "content-type": "application/json", ...(brand ? { "x-marque": brand } : {}) } }, (res) => {
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
      });
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
    const status = await call("GET", "/api/status", null, "kora");
    assert.equal(status.status, 200);
    assert.equal(status.body.connexions.marque.acces_illisibles, true);
    const save = await call("PUT", "/api/brand/connexions", { meta_token: "nouveau" }, "kora");
    assert.equal(save.status, 409);
    assert.match(save.body.erreur, /illisibles.*ne seront pas écrasés/);
    assert.equal((await call("POST", "/api/brand/validation-link", {}, "kora")).status, 409);
    assert.deepEqual(fs.readFileSync(broken), before, "fichier abîmé inchangé");
    // L'autre marque et le reste de Jurgenita fonctionnent.
    assert.equal((await call("PUT", "/api/brand/connexions", { linkedin_org_id: "7" }, "resto-afrik")).status, 200);
    assert.equal((await call("POST", "/api/briefing", {}, "kora")).status, 200);
    assert.equal((await call("POST", "/api/brand/validation-link", {}, "resto-afrik")).status, 200);
    assert.match(logs, /Accès illisibles pour : kora/);
    assert.match(logs, /1 fichier\(s\) temporaire\(s\)/);
    assert.ok(fs.existsSync(path.join(secrets, "brands", `.kora.json.abc123${TEMP_SUFFIX}`)), "le fichier temporaire n'est pas supprimé");
  } finally {
    server.kill();
  }
});
