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

// ---------------------------------------------------------------------------
// Sous-étape 2b.4 : VRAIES autorisations NTFS (ACL). Les résultats sont lus
// avec des outils indépendants du code testé (Get-Acl, icacls). Jurgenita ne
// modifie jamais les dossiers parents : seuls les tests en préparent.
// ---------------------------------------------------------------------------
import * as sd from "../src/secret-dir.js";
import * as win from "../src/secret-dir-windows.js";
import { createHash } from "node:crypto";

const SY = "S-1-5-18";
const BA = "S-1-5-32-544";
const BU = "S-1-5-32-545"; // Utilisateurs
const INVITES = "S-1-5-32-546";
const PLEIN = 2032127; // contrôle total

function psSync(script, env = {}) {
  const r = spawnSync(win.cheminPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, env: win.environnementPowerShell(env) });
  assert.equal(r.status, 0, `PowerShell : ${r.stderr}`);
  return r.stdout;
}
// Autorisations lues par l'API .NET des règles d'accès (FileSystemSecurity.GetAccessRules),
// indépendante de la lecture binaire du code testé ; dans l'ordre de la liste.
function lireAcl(p) {
  return JSON.parse(psSync([
    "$p = $env:JG_P",
    "if ([System.IO.Directory]::Exists($p)) { $a = [System.IO.Directory]::GetAccessControl($p) } else { $a = [System.IO.File]::GetAccessControl($p) }",
    "$t = [System.Security.Principal.SecurityIdentifier]",
    "$r = @($a.GetAccessRules($true, $true, $t) | ForEach-Object { @{ sid = $_.IdentityReference.Value; droits = [int]$_.FileSystemRights; type = [string]$_.AccessControlType; herite = $_.IsInherited; heritage = [string]$_.InheritanceFlags; propagation = [string]$_.PropagationFlags } })",
    "ConvertTo-Json -Compress -Depth 4 -InputObject @{ sddl = $a.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]'Owner, Group, Access'); protegee = $a.AreAccessRulesProtected; proprietaire = $a.GetOwner($t).Value; regles = $r }",
  ].join("; "), { JG_P: p }));
}
// Propriétaire, protection, entrées explicites dans l'ordre, entrées héritées
// comme ensemble : Windows recalcule ces dernières à partir du dossier parent,
// dans un ordre qu'aucune API standard ne fixe. L'ordre de règles qui ne font
// qu'autoriser est sans effet sur les droits, et un arbre contenant une règle
// de refus n'est jamais corrigé.
const etatAcl = (p) => {
  const a = lireAcl(p);
  const r = (x) => `${x.type}|${x.sid}|${x.droits}|${x.heritage}|${x.propagation}`;
  return JSON.stringify({ proprietaire: a.proprietaire, protegee: a.protegee, explicites: a.regles.filter((x) => !x.herite).map(r), herites: a.regles.filter((x) => x.herite).map(r).sort() });
};
const sidCourant = () => psSync("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value").trim();
function icacls(...args) {
  const r = spawnSync("icacls", args, { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, `icacls ${args.join(" ")} : ${r.stdout}${r.stderr}`);
}
const regles = (acl) => acl.regles.map((x) => `${x.sid}|${x.droits}|${x.type}|${x.herite ? "hérité" : "explicite"}`).sort();
const cibleAcl = (moi, herite) => [moi, SY, BA].map((s) => `${s}|${PLEIN}|Allow|${herite ? "hérité" : "explicite"}`).sort();
const empreinteW = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// ensureSecretsDir sur un dossier des secrets donné (sauvegardes à côté).
async function protegerSecrets(secrets, { permissions = "", env } = {}) {
  const avant = { ...process.env };
  process.env.JURGENITA_SECRETS_DIR = secrets;
  process.env.JURGENITA_SECRETS_PERMISSIONS = permissions;
  delete process.env.JURGENITA_SECRETS_BACKUP_DIR;
  try {
    const r = await sd.ensureSecretsDir(env ? { env } : {});
    console.log(`# protection : ${r.etat} / ${r.niveau} : ${r.resume}`);
    for (const p of r.problemes) console.log(`#   [${p.niveau}] ${p.code} : ${p.message}`);
    return r;
  } finally {
    for (const k of ["JURGENITA_SECRETS_DIR", "JURGENITA_SECRETS_PERMISSIONS", "JURGENITA_SECRETS_BACKUP_DIR"]) if (avant[k] === undefined) delete process.env[k]; else process.env[k] = avant[k];
  }
}

// Dossier des secrets trop ouvert : Utilisateurs en lecture (hérité par le
// contenu), Tout le monde en lecture explicite sur un fichier d'accès.
function arbreOuvert(base) {
  const data = path.join(base, "data");
  const secrets = path.join(data, "secrets");
  const brandsDir = path.join(secrets, "brands");
  const kora = path.join(brandsDir, "kora.json");
  const jeton = path.join(secrets, "google-token.json");
  fs.mkdirSync(brandsDir, { recursive: true });
  fs.writeFileSync(kora, JSON.stringify({ tiktok_token: "tkFactice2b4Windows" }));
  fs.writeFileSync(jeton, JSON.stringify({ refresh_token: "1//factice2b4" }));
  icacls(secrets, "/grant", `*${BU}:(OI)(CI)(RX)`);
  icacls(kora, "/grant", "*S-1-1-0:(R)");
  return { data, secrets, brandsDir, kora, jeton, sauvegardes: path.join(data, "secret-permissions-backups"), tous: [secrets, brandsDir, kora, jeton] };
}

async function jetonReel() {
  const lu = await win.inspecter(win.executerPowerShell, { arbres: [] });
  assert.equal(lu.ok, true, JSON.stringify(lu));
  const j = win.construireJeton(lu.jeton, await win.executerWhoami(["/user", "/fo", "csv", "/nh"]), await win.executerWhoami(["/groups", "/fo", "csv", "/nh"]));
  assert.equal(j.certain, true, j.problemes.join(" ; "));
  return j;
}
// PowerShell réel avec une panne injectée : l'opération visée est envoyée sur un chemin inexistant.
const psAvecPanne = (visee) => async (nom, env) => {
  if (nom === "appliquer") {
    const { ops } = JSON.parse(env.JG_OPERATIONS);
    env = { ...env, JG_OPERATIONS: JSON.stringify({ ops: ops.map((op) => (visee(op) ? { ...op, chemin: `${op.chemin}.panne-injectee` } : op)) }) };
  }
  return win.executerPowerShell(nom, env);
};

test("Windows : whoami et PowerShell appelés par leur chemin complet dans System32 (pas un homonyme du PATH)", onlyWindows, async () => {
  for (const p of [win.cheminWhoami(), win.cheminPowerShell()]) assert.ok(fs.existsSync(p), p);
  const u = await win.executerWhoami(["/user", "/fo", "csv", "/nh"]);
  assert.match(String(u), /S-1-5-/, "whoami de Windows (SID affiché)");
});

test("Windows (ACL réelle) : premier démarrage → dossier des secrets protégé exactement (vous, SYSTEM, Administrateurs ; héritage coupé)", onlyWindows, async () => {
  const base = newDir("acl-neuf");
  try {
    const data = path.join(base, "data");
    fs.mkdirSync(data);
    const secrets = path.join(data, "secrets");
    const r = await protegerSecrets(secrets);
    assert.equal(r.niveau, "sur", JSON.stringify(r.problemes));
    assert.equal(r.etat, "corrige");
    const moi = sidCourant();
    const acl = lireAcl(secrets);
    assert.equal(acl.protegee, true, "héritage coupé");
    assert.deepEqual(regles(acl), cibleAcl(moi, false), acl.sddl);
    assert.ok(acl.regles.every((x) => x.heritage === "ContainerInherit, ObjectInherit"), "transmis aux sous-dossiers et fichiers");
    const sv = lireAcl(path.join(data, "secret-permissions-backups"));
    assert.equal(sv.protegee, true, "dossier des sauvegardes protégé");
    assert.deepEqual(regles(sv), cibleAcl(moi, false), sv.sddl);
    // Vous gardez l'accès réel ; le contenu hérite de la protection.
    const kora = path.join(secrets, "brands", "kora.json");
    fs.mkdirSync(path.dirname(kora));
    fs.writeFileSync(kora, "{}");
    assert.equal(fs.readFileSync(kora, "utf8"), "{}");
    assert.deepEqual(regles(lireAcl(kora)), cibleAcl(moi, true));
    const r2 = await protegerSecrets(secrets);
    assert.equal(r2.etat, "protege", "second démarrage : rien à refaire");
  } finally { cleanup(base); }
});

test("Windows (ACL réelle) : autorisations trop larges → resserrées ; SYSTEM et Administrateurs gardés ; sauvegarde de l'état d'avant, protégée ; contenu identique", onlyWindows, async () => {
  const base = newDir("acl-ouvert");
  try {
    const t = arbreOuvert(base);
    const moi = sidCourant();
    assert.ok(lireAcl(t.secrets).regles.some((x) => x.sid === BU), "préparation : Utilisateurs présents");
    const contenu = t.tous.slice(2).map(empreinteW);
    const r = await protegerSecrets(t.secrets);
    assert.equal(r.etat, "corrige", JSON.stringify(r.problemes));
    assert.equal(r.niveau, "sur");
    const s = lireAcl(t.secrets);
    assert.equal(s.protegee, true);
    assert.deepEqual(regles(s), cibleAcl(moi, false), s.sddl);
    for (const p of t.tous.slice(1)) {
      const a = lireAcl(p);
      assert.equal(a.protegee, false, p);
      assert.deepEqual(regles(a), cibleAcl(moi, true), `${p} : héritage pur (${a.sddl})`);
    }
    assert.deepEqual(t.tous.slice(2).map(empreinteW), contenu, "contenu identique");
    const noms = fs.readdirSync(t.sauvegardes).filter((f) => f.startsWith("acl-") && f.endsWith(".json"));
    assert.equal(noms.length, 1);
    const sv = JSON.parse(fs.readFileSync(path.join(t.sauvegardes, noms[0]), "utf8"));
    const racineSv = sv.elements.find((e) => e.chemin === ".");
    assert.equal(racineSv.securite.protegee, false, "état d'avant : héritage actif");
    assert.ok(racineSv.securite.entrees.some((x) => x.sid === BU), "état d'avant : Utilisateurs");
    assert.ok(sv.elements.find((e) => e.chemin === "brands/kora.json").securite.entrees.some((x) => x.sid === "S-1-1-0"));
    assert.ok(!JSON.stringify(sv).includes("tkFactice2b4Windows"), "aucun secret dans la sauvegarde");
    assert.equal(lireAcl(t.sauvegardes).protegee, true);
    assert.deepEqual(regles(lireAcl(path.join(t.sauvegardes, noms[0]))), cibleAcl(moi, true), "sauvegarde protégée par héritage");
  } finally { cleanup(base); }
});

test("Windows (ACL réelle) : mode verifier → situation signalée, aucune écriture", onlyWindows, async () => {
  const base = newDir("acl-verifier");
  try {
    const t = arbreOuvert(base);
    const avant = t.tous.map((p) => lireAcl(p).sddl);
    const r = await protegerSecrets(t.secrets, { permissions: "verifier" });
    assert.equal(r.etat, "verification_seule");
    assert.equal(r.niveau, "dangereux", JSON.stringify(r.problemes));
    assert.ok(r.problemes.some((p) => p.code === "acces_autres_comptes" && p.message.includes(BU)), JSON.stringify(r.problemes));
    assert.deepEqual(t.tous.map((p) => lireAcl(p).sddl), avant, "aucune autorisation modifiée");
    assert.equal(fs.existsSync(t.sauvegardes), false, "aucun dossier des sauvegardes créé");
  } finally { cleanup(base); }
});

test("Windows (ACL réelle) : règle de refus, qu'elle vous concerne ou non → correction interrompue, rien modifié", onlyWindows, async () => {
  for (const [sid, vous] of [[BU, true], [INVITES, false]]) {
    const base = newDir("acl-refus");
    const t = arbreOuvert(base);
    try {
      icacls(t.kora, "/deny", `*${sid}:(WD)`);
      const avant = t.tous.map((p) => lireAcl(p).sddl);
      const r = await protegerSecrets(t.secrets);
      assert.equal(r.etat, "correction_interrompue", JSON.stringify(r.problemes));
      assert.ok(r.problemes.some((p) => p.code === "regle_de_refus" && p.vous === vous), `${sid} : ${JSON.stringify(r.problemes)}`);
      assert.deepEqual(t.tous.map((p) => lireAcl(p).sddl), avant, "aucune autorisation modifiée");
      assert.equal(fs.existsSync(t.sauvegardes), false, "rien écrit");
    } finally {
      icacls(t.kora, "/remove:d", `*${sid}`);
      cleanup(base);
    }
  }
});

test("Windows (ACL réelle) : dossier parent modifiable par un autre compte (DELETE, DELETE_CHILD, WRITE_DAC, WRITE_OWNER ; explicite ou hérité) → correction interrompue, parents jamais modifiés", onlyWindows, async () => {
  const cas = [
    { nom: "modification explicite", sur: "parent", droits: "(OI)(CI)(M)", code: "parent_droits", texte: "(explicite)" },
    { nom: "modification héritée", sur: "base", droits: "(OI)(CI)(M)", code: "parent_droits", texte: "(hérité)" },
    { nom: "suppression du contenu", sur: "parent", droits: "(DC)", code: "parent_suppression_contenu", texte: "DELETE_CHILD" },
    { nom: "modification des autorisations", sur: "parent", droits: "(WDAC)", code: "parent_droits", texte: "WRITE_DAC" },
    { nom: "prise de possession", sur: "parent", droits: "(WO)", code: "parent_droits", texte: "WRITE_OWNER" },
  ];
  for (const c of cas) {
    const base = newDir("acl-chaine");
    try {
      const parent = path.join(base, "parent");
      const secrets = path.join(parent, "secrets");
      fs.mkdirSync(secrets, { recursive: true });
      fs.writeFileSync(path.join(secrets, "google-token.json"), "{}");
      icacls(c.sur === "base" ? base : parent, "/grant", `*${BU}:${c.droits}`);
      const chaine = [base, parent, secrets, path.join(secrets, "google-token.json")];
      const avant = chaine.map((p) => lireAcl(p).sddl);
      const r = await protegerSecrets(secrets);
      assert.equal(r.etat, "correction_interrompue", `${c.nom} : ${JSON.stringify(r.problemes)}`);
      assert.equal(r.niveau, "dangereux", c.nom);
      assert.ok(r.problemes.some((p) => p.code === c.code && p.message.includes(c.texte) && p.message.includes(BU)), `${c.nom} : ${JSON.stringify(r.problemes)}`);
      assert.deepEqual(chaine.map((p) => lireAcl(p).sddl), avant, `${c.nom} : parents et dossier des secrets inchangés`);
      assert.equal(fs.existsSync(path.join(parent, "secret-permissions-backups")), false, `${c.nom} : rien écrit`);
    } finally { cleanup(base); }
  }
});

test("Windows (ACL réelle) : panne injectée après le dossier principal → restauration exacte, héritage compris", onlyWindows, async () => {
  const base = newDir("acl-panne");
  try {
    const t = arbreOuvert(base);
    const avant = t.tous.map(etatAcl);
    const jeton = await jetonReel();
    const lu = await win.inspecter(win.executerPowerShell, { arbres: [t.secrets] });
    const r = await win.protegerArbre({ racine: t.secrets, elements: lu.arbres[0].elements, jeton, ps: psAvecPanne((op) => op.chemin === t.kora && op.sddl === win.SDDL_HERITAGE_SEUL) });
    assert.equal(r.ok, false);
    assert.equal(r.etape, "application");
    assert.equal(r.restauration.etat, "restaure", JSON.stringify(r.restauration));
    assert.deepEqual(t.tous.map(etatAcl), avant, t.tous.map((p) => lireAcl(p).sddl).join("\n"));
  } finally { cleanup(base); }
});

test("Windows (ACL réelle) : panne pendant la restauration d'un élément contenu → dossier principal resté protégé, accès conservé", onlyWindows, async () => {
  const base = newDir("acl-partielle");
  try {
    const t = arbreOuvert(base);
    const moi = sidCourant();
    const jeton = await jetonReel();
    const lu = await win.inspecter(win.executerPowerShell, { arbres: [t.secrets] });
    const restaurationDeBrands = (op) => op.chemin === t.brandsDir && op.action === "dacl" && op.sddl !== win.SDDL_HERITAGE_SEUL && !op.sddl.startsWith("D:P(");
    const r = await win.protegerArbre({ racine: t.secrets, elements: lu.arbres[0].elements, jeton, ps: psAvecPanne((op) => (op.chemin === t.kora && op.sddl === win.SDDL_HERITAGE_SEUL) || restaurationDeBrands(op)) });
    assert.equal(r.ok, false);
    assert.equal(r.restauration.etat, "restauration_partielle", JSON.stringify(r.restauration));
    const s = lireAcl(t.secrets);
    assert.equal(s.protegee, true, "dossier principal resté protégé");
    assert.deepEqual(regles(s), cibleAcl(moi, false), s.sddl);
    const essai = path.join(t.secrets, "essai.json");
    fs.writeFileSync(essai, "{}");
    assert.equal(fs.readFileSync(essai, "utf8"), "{}");
    assert.ok(fs.readdirSync(t.secrets).includes("brands"), "accès conservé");
  } finally { cleanup(base); }
});

test("Windows (ACL réelle) : script de restauration → aperçu sans effet, application vérifiée, refus si le dossier des sauvegardes est exposé", onlyWindows, async () => {
  const base = newDir("acl-script");
  try {
    const t = arbreOuvert(base);
    const avant = t.tous.map(etatAcl);
    const r = await protegerSecrets(t.secrets);
    assert.equal(r.etat, "corrige", JSON.stringify(r.problemes));
    const protege = t.tous.map(etatAcl);
    const [nom] = fs.readdirSync(t.sauvegardes).filter((f) => f.startsWith("acl-"));
    const script = (...a) => spawnSync(process.execPath, [path.join(root, "scripts", "restaurer-droits-secrets.mjs"), path.join(t.sauvegardes, nom), ...a], { encoding: "utf8", env: { ...process.env, JURGENITA_SECRETS_DIR: t.secrets, JURGENITA_SECRETS_BACKUP_DIR: "" } });
    const apercu = script();
    assert.equal(apercu.status, 0, apercu.stdout + apercu.stderr);
    assert.match(apercu.stdout, /Aperçu seulement/);
    assert.deepEqual(t.tous.map(etatAcl), protege, "aperçu : rien modifié");
    const app = script("--appliquer");
    assert.equal(app.status, 0, app.stdout + app.stderr);
    assert.deepEqual(t.tous.map(etatAcl), avant, "autorisations d'origine rétablies");
    icacls(t.sauvegardes, "/grant", `*${BU}:(OI)(CI)(M)`);
    const refus = script("--appliquer");
    assert.equal(refus.status, 4, refus.stdout + refus.stderr);
    assert.match(refus.stderr, /Restauration refusée par prudence/);
  } finally { cleanup(base); }
});

test("Windows (ACL réelle) : retour arrière manuel documenté (icacls /reset) → héritage d'origine rétabli", onlyWindows, async () => {
  const base = newDir("acl-reset");
  try {
    const data = path.join(base, "data");
    const kora = path.join(data, "secrets", "brands", "kora.json");
    fs.mkdirSync(path.dirname(kora), { recursive: true });
    fs.writeFileSync(kora, "{}");
    const tous = [path.join(data, "secrets"), path.dirname(kora), kora];
    const avant = tous.map(etatAcl);
    const r = await protegerSecrets(tous[0]);
    assert.equal(r.etat, "corrige", JSON.stringify(r.problemes));
    assert.equal(lireAcl(tous[0]).protegee, true);
    icacls(tous[0], "/reset", "/T", "/C", "/Q");
    assert.deepEqual(tous.map(etatAcl), avant);
  } finally { cleanup(base); }
});

test("Windows (ACL réelle) : refus permanent sur le dossier des accès → 409 « Accès refusé » (pas 503), rien modifié", onlyWindows, async () => {
  const runtime = newDir("rt");
  const base = newDir("acl-409");
  const data = path.join(base, "data");
  fs.mkdirSync(data);
  const secrets = path.join(data, "secrets");
  const brandsDir = path.join(secrets, "brands");
  const moi = sidCourant();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, PORT: "0", JURGENITA_DEMO: "1", JURGENITA_NO_SCHEDULER: "1", JURGENITA_RUNTIME_DIR: runtime, JURGENITA_SECRETS_DIR: secrets, JURGENITA_SECRETS_BACKUP_DIR: "", JURGENITA_SECRETS_PERMISSIONS: "",
      META_ACCESS_TOKEN: "", TIKTOK_ACCESS_TOKEN: "", LINKEDIN_ACCESS_TOKEN: "", TELEGRAM_BOT_TOKEN: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" },
  });
  let logs = "";
  let refusPose = false;
  child.stdout.on("data", (c) => (logs += c));
  child.stderr.on("data", (c) => (logs += c));
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.on("data", () => { const m = logs.match(/http:\/\/[\d.]+:(\d+)/); if (m) resolve(Number(m[1])); });
      child.on("exit", (code) => reject(new Error(`serveur arrêté (${code}) : ${logs}`)));
    });
    assert.equal((await request(port, "PUT", "/api/brand/connexions", { meta_page_id: "page-1" })).status, 200);
    const file = path.join(brandsDir, "kora.json");
    const before = fs.readFileSync(file, "utf8");
    icacls(brandsDir, "/deny", `*${moi}:(WD,AD)`);
    refusPose = true;
    const res = await request(port, "PUT", "/api/brand/connexions", { meta_page_id: "page-2" });
    console.log(`# refus permanent réel : ${res.status} en ${res.ms} ms`);
    assert.equal(res.status, 409, `${JSON.stringify(res.body)}\n${logs}`);
    assert.match(res.body.erreur, /Accès refusé par les droits Windows/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(af.leftoverTemps(brandsDir), []);
  } finally {
    child.kill();
    if (refusPose) icacls(brandsDir, "/remove:d", `*${moi}`);
    cleanup(runtime);
    cleanup(base);
  }
});

test("Windows (ACL réelle) : .env lisible par d'autres comptes → information seulement, jamais modifié", onlyWindows, async () => {
  const base = newDir("acl-env");
  try {
    const data = path.join(base, "data");
    fs.mkdirSync(data);
    const env = path.join(base, ".env");
    fs.writeFileSync(env, "ANTHROPIC_API_KEY=sk-ant-factice-windows\n");
    icacls(env, "/grant", `*${BU}:(R)`);
    const avant = { acl: lireAcl(env).sddl, contenu: empreinteW(env) };
    const r = await protegerSecrets(path.join(data, "secrets"), { env });
    assert.equal(r.env?.niveau, "info", JSON.stringify(r.env));
    assert.ok(r.env.message.includes(BU), r.env.message);
    assert.match(r.env.action, /icacls \.env/);
    assert.match(r.env.action, /non appliqué automatiquement/);
    assert.deepEqual({ acl: lireAcl(env).sddl, contenu: empreinteW(env) }, avant, ".env jamais modifié");
    assert.ok(!JSON.stringify(r).includes("sk-ant-factice"));
  } finally { cleanup(base); }
});
