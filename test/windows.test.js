// Tests propres à Windows. Ils ne s'exécutent que sur un vrai Windows (CI
// windows-latest) ; ailleurs, ils apparaissent comme « ignorés » (skip), jamais
// en silence. Le CI vérifie en plus qu'aucun n'est ignoré sous Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic, readJsonFile, leftoverTemps } from "../src/atomic-file.js";

const onlyWindows = { skip: process.platform === "win32" ? false : "réservé à Windows" };

test("Windows : l'environnement est un vrai Windows", onlyWindows, () => {
  assert.equal(process.platform, "win32");
  assert.equal(os.type(), "Windows_NT");
  console.log(`# ${os.type()} ${os.release()}, Node ${process.version}`);
});

test("Windows : PowerShell 5.1 et icacls sont disponibles", onlyWindows, () => {
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
  assert.equal(ps.status, 0, ps.stderr);
  assert.equal(ps.stdout.trim(), "5", "Windows PowerShell 5.1 (celui livré avec Windows)");
  const acl = spawnSync("icacls", [os.tmpdir()], { encoding: "utf8" });
  assert.equal(acl.status, 0, acl.stderr);
});

test("Windows : l'écriture atomique remplace un fichier existant sur NTFS", onlyWindows, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-ntfs-"));
  try {
    const file = path.join(dir, "kora.json");
    for (let i = 0; i < 50; i++) writeJsonAtomic(file, { version: i, texte: "é ✨" });
    assert.deepEqual(readJsonFile(file), { etat: "ok", valeur: { version: 49, texte: "é ✨" } });
    assert.deepEqual(leftoverTemps(dir), [], "aucun fichier temporaire laissé");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sous-étape 2b.3 : VRAIS verrous NTFS (pas de simulation). Un processus
// PowerShell ouvre le fichier sans partage (FileShare.None), comme le ferait un
// antivirus ou un outil de synchronisation ; l'attribut « lecture seule » est
// posé par chmod (FILE_ATTRIBUTE_READONLY).
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as af from "../src/atomic-file.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const newDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `jurgenita-ntfs-${name}-`));
const cleanup = (dir) => { for (const f of fs.readdirSync(dir, { recursive: true })) { try { fs.chmodSync(path.join(dir, f), 0o666); } catch { /* */ } } fs.rmSync(dir, { recursive: true, force: true }); };

// Pose un verrou exclusif réel ; résout une fois le fichier verrouillé.
// release() tue le processus, ce qui libère le verrou.
async function ntfsLock(file, holdMs = 60_000) {
  const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('verrouille'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${holdMs}; $f.Close()`]);
  const exited = new Promise((resolve) => ps.on("exit", resolve));
  await new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    ps.stdout.on("data", (c) => { out += c; if (out.includes("verrouille")) resolve(); });
    ps.stderr.on("data", (c) => (err += c));
    ps.on("exit", (code) => reject(new Error(`PowerShell n'a pas pu verrouiller (code ${code}) : ${err}`)));
  });
  return { exited, release: async () => { ps.kill(); await exited; } };
}

test("Windows (verrou NTFS réel) : verrou passager → l'écriture attend sans bloquer, puis réussit", onlyWindows, async () => {
  const dir = newDir("passager");
  try {
    const file = path.join(dir, "kora.json");
    fs.writeFileSync(file, JSON.stringify({ ancien: true }));
    const lock = await ntfsLock(file, 1500);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const t0 = Date.now();
    try { await af.writeJsonAtomicAsync(file, { nouveau: "é ✨" }, { budgetMs: 8000 }); } finally { clearInterval(timer); }
    const elapsed = Date.now() - t0;
    await lock.exited;
    console.log(`# verrou réel : écriture réussie après ${elapsed} ms, ${ticks} minuteries exécutées pendant l'attente`);
    assert.ok(elapsed >= 500, `l'écriture a bien attendu le verrou (${elapsed} ms)`);
    assert.ok(ticks >= 20, "programme non bloqué pendant l'attente");
    assert.deepEqual(af.readJsonFile(file), { etat: "ok", valeur: { nouveau: "é ✨" } });
    assert.deepEqual(af.leftoverTemps(dir), []);
  } finally { cleanup(dir); }
});

test("Windows (verrou NTFS réel) : verrou permanent → FileBusyError (503), contenu intact, temporaire retiré", onlyWindows, async () => {
  const dir = newDir("permanent");
  try {
    const file = path.join(dir, "kora.json");
    const content = JSON.stringify({ ancien: true });
    fs.writeFileSync(file, content);
    const lock = await ntfsLock(file);
    let err;
    try { await af.writeJsonAtomicAsync(file, { nouveau: true }, { budgetMs: 1500 }); } catch (e) { err = e; }
    await lock.release();
    assert.ok(err instanceof af.FileBusyError, `erreur reçue : ${err?.name} ${err?.code ?? ""}`);
    assert.equal(err.status, 503);
    assert.equal(fs.readFileSync(file, "utf8"), content);
    assert.deepEqual(af.leftoverTemps(dir), []);
  } finally { cleanup(dir); }
});

test("Windows (attribut NTFS réel) : fichier en lecture seule → refus 409 immédiat, contenu et attribut conservés", onlyWindows, async () => {
  const dir = newDir("lecture-seule");
  try {
    const file = path.join(dir, "kora.json");
    const content = JSON.stringify({ protege: true });
    fs.writeFileSync(file, content);
    fs.chmodSync(file, 0o444);
    const attrib = () => spawnSync("attrib", [file], { encoding: "utf8" }).stdout;
    assert.match(attrib().slice(0, 12), /R/, "attribut lecture seule posé");
    const t0 = Date.now();
    await assert.rejects(af.writeJsonAtomicAsync(file, { remplace: true }, { budgetMs: 8000 }), (e) => e instanceof af.ReadOnlyFileError && e.status === 409);
    assert.ok(Date.now() - t0 < 1000, "sans attendre le budget de reprise");
    assert.equal(fs.readFileSync(file, "utf8"), content);
    assert.match(attrib().slice(0, 12), /R/, "attribut lecture seule conservé");
    assert.deepEqual(af.leftoverTemps(dir), []);
  } finally { cleanup(dir); }
});

test("Windows (verrou NTFS réel) : lecture verrouillée → « verrouillé » (pas « abîmé »), puis reprise", onlyWindows, async () => {
  const dir = newDir("lecture");
  try {
    const file = path.join(dir, "kora.json");
    fs.writeFileSync(file, JSON.stringify({ ok: 1 }));
    const lock = await ntfsLock(file, 1500);
    const r = af.readJsonFile(file);
    console.log(`# lecture sous verrou réel : ${JSON.stringify(r.erreur?.diagnostic)}`);
    assert.equal(r.etat, "illisible");
    assert.equal(r.erreur.diagnostic.categorie, "verrouille");
    assert.deepEqual(await af.readJsonFileRetrying(file, { budgetMs: 8000 }), { etat: "ok", valeur: { ok: 1 } });
    await lock.exited;
  } finally { cleanup(dir); }
});

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "content-type": "application/json", "x-marque": "kora" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let json = null; try { json = JSON.parse(d); } catch { /* */ } resolve({ status: res.statusCode, headers: res.headers, body: json, ms: Date.now() - t0 }); });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test("Windows (verrou NTFS réel) : serveur complet → autres routes disponibles, 200 après libération, 503 + Retry-After si le verrou persiste", onlyWindows, async () => {
  const runtime = newDir("rt");
  const secrets = newDir("sec");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, PORT: "0", JURGENITA_DEMO: "1", JURGENITA_NO_SCHEDULER: "1", JURGENITA_RUNTIME_DIR: runtime, JURGENITA_SECRETS_DIR: secrets,
      META_ACCESS_TOKEN: "", TIKTOK_ACCESS_TOKEN: "", LINKEDIN_ACCESS_TOKEN: "", TELEGRAM_BOT_TOKEN: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" },
  });
  let logs = "";
  child.stdout.on("data", (c) => (logs += c));
  child.stderr.on("data", (c) => (logs += c));
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.on("data", () => { const m = logs.match(/http:\/\/[\d.]+:(\d+)/); if (m) resolve(Number(m[1])); });
      child.on("exit", (code) => reject(new Error(`serveur arrêté (${code}) : ${logs}`)));
    });
    const file = path.join(secrets, "brands", "kora.json");
    assert.equal((await request(port, "PUT", "/api/brand/connexions", { meta_page_id: "page-1" })).status, 200);

    // Verrou passager : l'enregistrement attend, le reste du serveur répond.
    const lock = await ntfsLock(file, 2500);
    let settled = false;
    const pending = request(port, "PUT", "/api/brand/connexions", { linkedin_org_id: "org-2" }).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 500));
    const status = await request(port, "GET", "/api/status");
    console.log(`# serveur sous verrou réel : /api/status en ${status.ms} ms pendant l'attente`);
    assert.equal(status.status, 200);
    assert.ok(status.ms < 1500, `réponse en ${status.ms} ms`);
    assert.equal(settled, false, "l'enregistrement attend le verrou");
    const res = await pending;
    await lock.exited;
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { meta_page_id: "page-1", linkedin_org_id: "org-2" });

    // Verrou persistant : 503 avec Retry-After, fichier inchangé.
    const before = fs.readFileSync(file, "utf8");
    const lock2 = await ntfsLock(file);
    const busy = await request(port, "PUT", "/api/brand/connexions", { meta_page_id: "page-3" });
    await lock2.release();
    assert.equal(busy.status, 503);
    assert.ok(Number(busy.headers["retry-after"]) > 0);
    assert.match(busy.body.erreur, /verrouillés/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(af.leftoverTemps(path.dirname(file)), []);
  } finally {
    child.kill();
    cleanup(runtime);
    cleanup(secrets);
  }
});

test("Windows (verrou NTFS réel) : jetons TikTok et LinkedIn toujours masqués pendant le verrou, jamais utilisés", onlyWindows, async () => {
  const TIKTOK = "tkQz81Lm4Xw7Pc2VbN6dR3";
  const LINKEDIN = "liWp52Hs9Ke3Gd7Tq4Mz8";
  const runtime = newDir("rt");
  const secrets = newDir("sec");
  const file = path.join(secrets, "brands", "kora.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tiktok_token: TIKTOK, linkedin_token: LINKEDIN, linkedin_org_id: "org-1" }));
  const srcUrl = (name) => pathToFileURL(path.join(root, "src", name)).href;
  const script = `
    const redaction = await import(${JSON.stringify(srcUrl("redact.js"))});
    const brands = await import(${JSON.stringify(srcUrl("brands.js"))});
    redaction.installConsoleRedaction();
    redaction.addSecretSource(() => brands.secretsForRedaction());
    const step = async (name) => { process.stdout.write("@@" + name + "\\n"); await new Promise((r) => process.stdin.once("data", r)); };
    console.log("A", process.env.T1, process.env.T2);
    await step("verrouiller");
    console.log("B", process.env.T1, process.env.T2);
    const c = brands.config("kora");
    const out = { config: { tiktok: c.tiktok.token, linkedin: c.linkedin.token }, statut: JSON.stringify(brands.connectionStatus("kora")) };
    await step("liberer");
    console.log("C", process.env.T1, process.env.T2);
    process.stdout.write("@@resultat " + JSON.stringify(out) + "\\n");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: { ...process.env, T1: TIKTOK, T2: LINKEDIN, JURGENITA_SECRETS_DIR: secrets, JURGENITA_RUNTIME_DIR: runtime, TIKTOK_ACCESS_TOKEN: "", LINKEDIN_ACCESS_TOKEN: "", META_ACCESS_TOKEN: "" },
  });
  let stdout = "";
  let stderr = "";
  let lock;
  const handled = new Set();
  child.stderr.on("data", (c) => (stderr += c));
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on("data", async (c) => {
        stdout += c;
        try {
          if (stdout.includes("@@verrouiller\n") && !handled.has("v")) { handled.add("v"); lock = await ntfsLock(file); child.stdin.write("ok\n"); }
          if (stdout.includes("@@liberer\n") && !handled.has("l")) { handled.add("l"); await lock.release(); child.stdin.write("ok\n"); }
          if (/@@resultat .*\n/.test(stdout)) { child.stdin.end(); resolve(); }
        } catch (e) { reject(e); }
      });
      child.on("exit", () => resolve());
    });
    const logs = stdout + stderr;
    for (const line of ["A", "B", "C"]) assert.match(stdout, new RegExp(`^${line} \\[masqué\\] \\[masqué\\]`, "m"), `ligne ${line} masquée :\n${logs}`);
    for (const t of [TIKTOK, LINKEDIN]) for (let i = 0; i + 6 <= t.length; i++) assert.ok(!logs.includes(t.slice(i, i + 6)), `fragment dans le journal :\n${logs}`);
    assert.match(stderr, /momentanément inaccessibles/, "verrou réellement rencontré pendant la ligne B");
    const out = JSON.parse(/@@resultat (.*)/.exec(stdout)[1]);
    assert.deepEqual(out.config, { tiktok: "", linkedin: "" }, "le cache ne sert jamais aux connecteurs");
    assert.ok(!out.statut.includes(TIKTOK.slice(0, 6)) && !out.statut.includes(LINKEDIN.slice(0, 6)));
  } finally {
    if (lock) await lock.release().catch(() => {});
    child.kill();
    cleanup(runtime);
    cleanup(secrets);
  }
});
