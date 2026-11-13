// Sous-étape 2b.4 : protection des dossiers de secrets.
//
// Trois familles de tests :
// - PORTABLES (toutes plateformes) : logique Linux, macOS et Windows sur des
//   données simulées (vue de fichiers, annuaires, ACL, modèle d'ACL Windows en
//   mémoire pour l'ordre des opérations et de la restauration) ;
// - Linux et macOS RÉELS : vrais droits, vrais dossiers temporaires ;
// - macOS SEUL : ACL étendues réelles.
// Les vraies ACL NTFS sont testées dans windows.test.js. Chaque test distingue
// les situations sûres, incertaines et dangereuses.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as sd from "../src/secret-dir.js";
import * as win from "../src/secret-dir-windows.js";
import * as af from "../src/atomic-file.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcUrl = (...parts) => pathToFileURL(path.join(root, "src", ...parts)).href;
const posix = process.platform !== "win32";
const estRoot = posix && process.getuid() === 0;
const surPosix = { skip: posix ? false : "réservé à Linux et macOS" };
const surPosixNonRoot = { skip: !posix ? "réservé à Linux et macOS" : estRoot ? "en root, les droits ne s'appliquent pas" : false };
const surPosixRoot = { skip: estRoot ? false : "nécessite root (propriétaire différent réel)" };
const surMac = { skip: process.platform === "darwin" ? false : "réservé à macOS" };
const dossiers = [];
after(() => dossiers.forEach((d) => { spawnSync(posix ? "chmod" : "cmd", posix ? ["-R", "u+rwx", d] : ["/c", "rem"]); fs.rmSync(d, { recursive: true, force: true }); }));
function base(nom) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `jurgenita-2b4-${nom}-`));
  dossiers.push(d);
  return d;
}
const mode = (p) => fs.lstatSync(p).mode & 0o7777;
const empreinte = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const niveaux = (ps) => [...new Set(ps.map((p) => p.niveau))].sort();

// ===========================================================================
// PORTABLES
// ===========================================================================

test("mode de protection : corriger par défaut, verifier, valeur inconnue = vérification", () => {
  const avant = process.env.JURGENITA_SECRETS_PERMISSIONS;
  try {
    for (const [v, attendu] of [[undefined, { mode: "corriger" }], ["corriger", { mode: "corriger" }], ["verifier", { mode: "verifier" }], ["VERIFIER", { mode: "verifier" }], ["oui", { mode: "verifier", inconnu: "oui" }]]) {
      if (v === undefined) delete process.env.JURGENITA_SECRETS_PERMISSIONS; else process.env.JURGENITA_SECRETS_PERMISSIONS = v;
      assert.deepEqual(sd.modeProtection(), attendu, String(v));
    }
  } finally {
    if (avant === undefined) delete process.env.JURGENITA_SECRETS_PERMISSIONS; else process.env.JURGENITA_SECRETS_PERMISSIONS = avant;
  }
});

test("chemins centralisés : marques, sources et google.js visent le même dossier ; sauvegardes à côté, jamais dedans", () => {
  const b = base("chemins");
  const secrets = path.join(b, "data", "secrets");
  fs.mkdirSync(secrets, { recursive: true });
  fs.writeFileSync(path.join(secrets, "google-token.json"), JSON.stringify({ refresh_token: "1//valeur-factice-de-test", scope: "" }));
  const script = `
    const sd = await import(${JSON.stringify(srcUrl("secret-dir.js"))});
    const sources = await import(${JSON.stringify(srcUrl("sources.js"))});
    const google = await import(${JSON.stringify(srcUrl("connectors", "google.js"))});
    process.stdout.write(JSON.stringify({ racine: sd.secretsRoot(), marques: sd.brandsDir(), jeton: sd.googleTokenFile(), sauvegardes: sd.backupsDir(), googleConnecte: google.connected(), sourcesConnecte: sources.googleState().connecte }));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", cwd: root,
    env: { ...process.env, JURGENITA_SECRETS_DIR: secrets, JURGENITA_RUNTIME_DIR: path.join(b, "rt"), GOOGLE_CLIENT_ID: "faux", GOOGLE_CLIENT_SECRET: "faux" },
  });
  assert.equal(run.status, 0, run.stderr);
  const r = JSON.parse(run.stdout);
  assert.equal(r.racine, secrets);
  assert.equal(r.marques, path.join(secrets, "brands"));
  assert.equal(r.jeton, path.join(secrets, "google-token.json"));
  assert.equal(r.sauvegardes, path.join(b, "data", sd.NOM_SAUVEGARDES), "à côté du dossier des secrets");
  assert.equal(r.googleConnecte, true, "google.js lit le jeton au même endroit");
  assert.equal(r.sourcesConnecte, true, "sources.js lit le jeton au même endroit");
});

test("configuration : un dossier des sauvegardes placé dans le dossier des secrets interrompt tout (aucune écriture)", async () => {
  const b = base("config");
  const secrets = path.join(b, "secrets");
  fs.mkdirSync(secrets, { mode: 0o755 });
  const avant = { ...process.env };
  process.env.JURGENITA_SECRETS_DIR = secrets;
  process.env.JURGENITA_SECRETS_BACKUP_DIR = path.join(secrets, "sauvegardes");
  try {
    const r = await sd.ensureSecretsDir();
    assert.equal(r.etat, "correction_interrompue");
    assert.ok(r.problemes.some((p) => p.code === "configuration"));
    assert.equal(r.niveau, "incertain");
    assert.ok(!fs.existsSync(path.join(secrets, "sauvegardes")));
    if (posix) assert.equal(mode(secrets), 0o755, "rien n'a été modifié");
  } finally {
    for (const k of ["JURGENITA_SECRETS_DIR", "JURGENITA_SECRETS_BACKUP_DIR"]) if (avant[k] === undefined) delete process.env[k]; else process.env[k] = avant[k];
  }
});

test("EACCES : refus immédiat sous Linux et macOS, reprises de la 2b.3 inchangées sous Windows et pour EPERM", async () => {
  const refus = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  const lecture = { ...fs, readFileSync: () => { throw refus(); } };
  assert.equal(af.readJsonFile("x.json", { fsImpl: lecture, platform: "linux" }).erreur.diagnostic.categorie, "acces_refuse");
  assert.equal(af.readJsonFile("x.json", { fsImpl: lecture, platform: "darwin" }).erreur.diagnostic.categorie, "acces_refuse");
  assert.equal(af.readJsonFile("x.json", { fsImpl: lecture, platform: "win32" }).erreur.diagnostic.categorie, "verrouille");
  const b = base("eacces");
  const fichier = path.join(b, "kora.json");
  let essais = 0;
  const renommage = (code) => ({ ...fs, promises: { ...fs.promises, rename: async () => { essais++; throw Object.assign(new Error(code), { code }); } } });
  let t0 = Date.now();
  essais = 0;
  await assert.rejects(af.writeJsonAtomicAsync(fichier, { v: 1 }, { fsImpl: renommage("EACCES"), platform: "linux", budgetMs: 3000 }), (e) => e instanceof af.AccessDeniedError && e.status === 409);
  assert.equal(essais, 1, "aucune reprise : le refus est permanent");
  assert.ok(Date.now() - t0 < 1000, "immédiat");
  t0 = Date.now();
  essais = 0;
  await assert.rejects(af.writeJsonAtomicAsync(fichier, { v: 1 }, { fsImpl: renommage("EACCES"), platform: "win32", budgetMs: 400 }), af.FileBusyError);
  assert.ok(essais > 1 && Date.now() - t0 >= 350, "Windows : reprises de la 2b.3 conservées");
  essais = 0;
  await assert.rejects(af.writeJsonAtomicAsync(fichier, { v: 1 }, { fsImpl: renommage("EPERM"), platform: "linux", budgetMs: 400 }), af.FileBusyError);
  assert.ok(essais > 1, "EPERM : toujours repris (verrou passager possible)");
  assert.deepEqual(af.leftoverTemps(b), []);
});

// --- Linux et macOS, simulés -------------------------------------------------

// Vue de fichiers simulée : { chemin réel: { mode, uid, gid, type: "d"|"f"|"l", cible? } }.
// Comme le vrai système : les liens des composants intermédiaires sont suivis,
// le dernier composant ne l'est pas (lstat).
function vueSimulee(arbre) {
  const reel = (p) => {
    let res = "/";
    for (const m of p.split("/").filter(Boolean)) {
      const c = path.posix.join(res, m);
      const e = arbre[c];
      if (!e) return null;
      res = e.type === "l" ? e.cible : c;
    }
    return res === "/" || arbre[res] ? res : null;
  };
  const entree = (p) => {
    if (p === "/") return arbre["/"];
    const parent = reel(path.posix.dirname(p));
    return parent ? arbre[path.posix.join(parent, path.posix.basename(p))] : undefined;
  };
  return {
    lstat(p) { const e = entree(p); return e ? { mode: e.mode, uid: e.uid, gid: e.gid ?? e.uid, dossier: e.type === "d", fichier: e.type === "f", lien: e.type === "l" } : null; },
    realpath: reel,
    readdir(p) { const r = reel(p); return Object.keys(arbre).filter((k) => k !== r && path.posix.dirname(k) === r).map((k) => path.posix.basename(k)); },
    access() { return true; },
  };
}
const MOI = { uid: 1000, gid: 1000, nom: "moi" };
const ACL_AUCUNE = () => ({ lisible: true, presente: false, entrees: [] });
const GROUPE_SEUL = () => ({ certain: true, autres: [] });
const chaine = (arbre, opts = {}) => sd.analyserChainePosix({ sensible: "/home/moi/projet/data/secrets", vue: vueSimulee(arbre), moi: MOI, groupe: GROUPE_SEUL, acl: ACL_AUCUNE, plateforme: "linux", ...opts });
const arbreSain = () => ({
  "/": { mode: 0o755, uid: 0, type: "d" },
  "/home": { mode: 0o755, uid: 0, type: "d" },
  "/home/moi": { mode: 0o750, uid: 1000, type: "d" },
  "/home/moi/projet": { mode: 0o755, uid: 1000, type: "d" },
  "/home/moi/projet/data": { mode: 0o755, uid: 1000, type: "d" },
  "/home/moi/projet/data/secrets": { mode: 0o700, uid: 1000, type: "d" },
});

test("POSIX (simulé) : resserrement seulement — jamais un droit ajouté", () => {
  const arbre = {
    "/s": { mode: 0o755, uid: 1000, type: "d" },
    "/s/a.json": { mode: 0o644, uid: 1000, type: "f" },
    "/s/b.json": { mode: 0o666, uid: 1000, type: "f" },
    "/s/c.json": { mode: 0o444, uid: 1000, type: "f" },
    "/s/d.json": { mode: 0o600, uid: 1000, type: "f" },
    "/s/e.json": { mode: 0o400, uid: 1000, type: "f" },
    "/s/f": { mode: 0o2775, uid: 1000, type: "d" },
    "/s/g": { mode: 0o555, uid: 1000, type: "d" },
    "/s/h.json": { mode: 0o640, uid: 1000, type: "f" },
  };
  const a = sd.analyserArbrePosix({ racine: "/s", vue: vueSimulee(arbre), moi: MOI, plateforme: "linux", acl: ACL_AUCUNE });
  const plan = Object.fromEntries(a.aCorriger.map((c) => [c.chemin, (c.apres).toString(8)]));
  assert.deepEqual(plan, { "/s": "700", "/s/a.json": "600", "/s/b.json": "600", "/s/c.json": "400", "/s/f": "700", "/s/g": "500", "/s/h.json": "600" });
  for (const c of a.aCorriger) assert.equal(c.apres & ~c.avant, 0, `${c.chemin} : aucun bit ajouté`);
});

test("POSIX (simulé) : propriétaire étranger, lien symbolique, élément inattendu → pas de correction (dangereux / incertain)", () => {
  const a = sd.analyserArbrePosix({ racine: "/s", vue: vueSimulee({ "/s": { mode: 0o755, uid: 1001, type: "d" } }), moi: MOI, plateforme: "linux", acl: ACL_AUCUNE });
  assert.deepEqual(a.aCorriger, []);
  assert.ok(a.problemes.some((p) => p.code === "proprietaire_etranger" && p.niveau === "dangereux" && p.bloquant));
  const l = sd.analyserArbrePosix({ racine: "/s", vue: vueSimulee({ "/s": { mode: 0o777, uid: 1000, type: "l", cible: "/x" }, "/x": { mode: 0o755, uid: 1000, type: "d" } }), moi: MOI, plateforme: "linux", acl: ACL_AUCUNE });
  assert.ok(l.problemes.some((p) => p.code === "lien_symbolique" && p.niveau === "incertain"));
  assert.deepEqual(l.aCorriger, [], "aucune correction à travers un lien");
  // Élément inaccessible : à vous (droits à rendre) ou à un autre compte, root compris (propriété à reprendre).
  for (const [uid, etranger] of [[1000, false], [0, true]]) {
    const v = vueSimulee({ "/s": { mode: 0o000, uid, type: "d" } });
    v.access = () => false;
    const r = sd.analyserArbrePosix({ racine: "/s", vue: v, moi: MOI, plateforme: "linux", acl: ACL_AUCUNE });
    assert.ok(r.problemes.some((p) => p.code === "acces_refuse" && p.acces));
    assert.equal(r.inaccessiblesEtrangers, etranger, `uid ${uid}`);
  }
});

test("POSIX (simulé) : chaîne sûre (dossier personnel)", () => {
  assert.deepEqual(chaine(arbreSain()), []);
});

test("POSIX (simulé) : parent modifiable par tous sans bit sticky → dangereux ; avec bit sticky → sûr", () => {
  const a = arbreSain();
  a["/home/moi/projet"].mode = 0o777;
  const p = chaine(a);
  assert.deepEqual(niveaux(p), ["dangereux"]);
  assert.ok(p.some((x) => x.code === "parent_modifiable_par_tous" && x.message.includes("/home/moi/projet")));
  a["/home/moi/projet"].mode = 0o1777;
  assert.deepEqual(chaine(a), [], "bit sticky : seuls les propriétaires peuvent renommer");
});

test("POSIX (simulé) : bit sticky mais élément ou dossier appartenant à un autre compte → dangereux", () => {
  const a = arbreSain();
  a["/home/moi/projet"].mode = 0o1777;
  a["/home/moi/projet/data"].uid = 1001;
  assert.ok(chaine(a).some((x) => x.code === "parent_proprietaire" && x.niveau === "dangereux"));
  const b = arbreSain();
  b["/home/moi/projet"] = { mode: 0o1777, uid: 1001, type: "d" };
  assert.ok(chaine(b).some((x) => x.code === "parent_proprietaire" && x.message.includes("uid 1001")));
});

test("POSIX (simulé) : parent modifiable par un groupe — seul vous (sûr), autres membres (dangereux), membres inconnus (incertain)", () => {
  const a = arbreSain();
  a["/home/moi/projet/data"].mode = 0o775;
  assert.deepEqual(chaine(a), []);
  const d = chaine(a, { groupe: () => ({ certain: true, autres: ["bob"] }) });
  assert.ok(d.some((x) => x.code === "parent_modifiable_par_groupe" && x.niveau === "dangereux" && x.message.includes("bob")));
  const i = chaine(a, { groupe: () => ({ certain: false, raison: "annuaire passwd non local (sss)" }) });
  assert.deepEqual(niveaux(i), ["incertain"]);
  assert.ok(i.some((x) => x.code === "groupe_incertain"));
});

test("POSIX (simulé) : ACL Linux — illisible (incertain), utilisateur nommé (dangereux), masque sans écriture (sûr)", () => {
  const a = arbreSain();
  a["/home/moi/projet/data"].mode = 0o775;
  assert.deepEqual(niveaux(chaine(a, { acl: () => ({ lisible: false, presente: true, raison: "ACL présente mais getfacl indisponible" }) })), ["incertain"]);
  const nomme = { lisible: true, presente: true, entrees: [{ type: "user", nom: "", droits: "rwx" }, { type: "user", nom: "bob", droits: "rwx" }, { type: "group", nom: "", droits: "r-x" }, { type: "mask", nom: "", droits: "rwx" }, { type: "other", nom: "", droits: "r-x" }] };
  assert.ok(chaine(a, { acl: () => nomme }).some((x) => x.code === "parent_acl" && x.message.includes("bob")));
  const masque = { ...nomme, entrees: nomme.entrees.map((e) => (e.type === "mask" ? { ...e, droits: "r-x" } : e)) };
  assert.deepEqual(chaine(a, { acl: () => masque }), [], "le masque empêche toute écriture des entrées nommées");
});

test("POSIX (simulé) : lien symbolique dans le chemin — évalué dans le dossier qui le contient", () => {
  const a = arbreSain();
  a["/home/moi/lien"] = { mode: 0o777, uid: 1000, type: "l", cible: "/home/moi/projet" };
  const sensible = "/home/moi/lien/data/secrets";
  assert.deepEqual(sd.analyserChainePosix({ sensible, vue: vueSimulee(a), moi: MOI, groupe: GROUPE_SEUL, acl: ACL_AUCUNE, plateforme: "linux" }), []);
  a["/home/moi"].mode = 0o777;
  assert.ok(sd.analyserChainePosix({ sensible, vue: vueSimulee(a), moi: MOI, groupe: GROUPE_SEUL, acl: ACL_AUCUNE, plateforme: "linux" }).some((x) => x.code === "parent_modifiable_par_tous"));
});

test("POSIX (simulé) : ACL macOS — autorisation à un autre compte (dangereux), refus ignoré (sûr), illisible (incertain)", () => {
  const a = arbreSain();
  const mac = (entrees) => () => ({ lisible: true, presente: entrees.length > 0, entrees });
  assert.deepEqual(chaine(a, { plateforme: "darwin", acl: mac([{ principal: "group", nom: "everyone", autoriser: false, droits: ["delete"], heritageSeul: false }]) }), []);
  assert.ok(chaine(a, { plateforme: "darwin", acl: mac([{ principal: "group", nom: "everyone", autoriser: true, droits: ["add_subdirectory"], heritageSeul: false }]) }).some((x) => x.code === "parent_acl" && x.niveau === "dangereux"));
  assert.deepEqual(niveaux(chaine(a, { plateforme: "darwin", acl: () => ({ lisible: false, raison: "ACL illisible" }) })), ["incertain"]);
});

test("annuaires Linux : locaux = certain ; sss/ldap, entrées NIS, userdb = incertain ; membres comptés", () => {
  const fichiers = (nss, groupe = "moi:x:1000:\nprojet:x:2000:moi,bob\n", passwd = "root:x:0:0::/root:/bin/sh\nmoi:x:1000:1000::/home/moi:/bin/sh\nalice:x:1001:2000::/home/alice:/bin/sh\n", userdb = []) => sd.groupesLinux({
    lire: (f) => ({ "/etc/nsswitch.conf": nss, "/etc/group": groupe, "/etc/passwd": passwd })[f] ?? (() => { throw new Error("absent"); })(),
    lister: (d) => (d === "/etc/userdb" ? userdb : (() => { throw new Error("absent"); })()),
  });
  assert.deepEqual(fichiers("passwd: files systemd\ngroup: files systemd\n")(1000, MOI), { certain: true, autres: [] });
  assert.deepEqual(fichiers("passwd: files\ngroup: files\n")(2000, MOI), { certain: true, autres: ["bob", "alice"] });
  assert.equal(fichiers("passwd: files sss\ngroup: files sss\n")(1000, MOI).certain, false);
  assert.equal(fichiers("passwd: compat\ngroup: compat\n", "+@netgroup\n")(1000, MOI).certain, false);
  assert.equal(fichiers("passwd: files systemd\ngroup: files systemd\n", undefined, undefined, ["moi.membership"])(1000, MOI).certain, false);
});

test("annuaires macOS : recherche locale = certain ; Active Directory, LDAP, groupes imbriqués, sortie illisible = incertain", () => {
  const sorties = (recherche, groupe = "name: projet\npassword: *\ngid: 2000\nusers: moi bob\n", fiche = "RecordName: projet\nPrimaryGroupID: 2000\n") => (c, a) => {
    if (c === "dscl" && a[0] === "/Search") return recherche;
    if (c === "dscacheutil") return groupe;
    if (c === "dscl" && a[1] === "-read") return fiche;
    if (c === "dscl" && a[1] === "-list") return "moi 20\nalice 2000\nroot 0\n";
    throw new Error("commande inattendue");
  };
  const g = (...s) => sd.groupesMac({ executer: sorties(...s) })(2000, MOI);
  assert.deepEqual(g("CSPSearchPath: /Local/Default /BSD/local\n"), { certain: true, autres: ["bob", "alice"] });
  assert.equal(g("CSPSearchPath:\n /Local/Default\n /BSD/local\n /Active Directory/EXEMPLE/All Domains\n").certain, false);
  assert.match(g("CSPSearchPath: /Local/Default /LDAPv3/ldap.exemple.fr\n").raison, /LDAPv3/);
  assert.equal(g("CSPSearchPath: /Local/Default\n", undefined, "RecordName: projet\nNestedGroups: ABCDEF01-0000\n").certain, false);
  assert.equal(g("illisible").certain, false);
});

test("outils Linux et macOS : chemin complet quand il existe, PATH en dernier recours", () => {
  assert.equal(sd.outil("ls", (p) => p === "/bin/ls"), "/bin/ls");
  assert.equal(sd.outil("ls", (p) => p === "/usr/bin/ls"), "/usr/bin/ls");
  assert.equal(sd.outil("dscl", (p) => p === "/usr/bin/dscl"), "/usr/bin/dscl");
  assert.equal(sd.outil("ls", () => false), "ls");
  if (process.platform === "darwin") assert.equal(sd.outil("ls"), "/bin/ls", "le ls de macOS, jamais un ls GNU du PATH");
});

test("lecture des ACL : getfacl (Linux) et ls -le (macOS)", () => {
  const linux = sd.aclLinux({ executer: (c) => (c === "ls" ? "drwxrwxr-x+ 2 moi moi 4096 nov. 13 08:00 /p\n" : "user::rwx\nuser:bob:rwx\t#effective:r-x\ngroup::r-x\nmask::r-x\nother::r-x\n") })("/p");
  assert.deepEqual(linux.entrees.find((e) => e.nom === "bob"), { type: "user", nom: "bob", droits: "r-x" }, "droits effectifs (masque) retenus");
  assert.equal(sd.aclLinux({ executer: () => "drwxr-xr-x 2 moi moi 4096 nov. 13 08:00 /p\n" })("/p").presente, false);
  const mac = sd.aclMac({ executer: () => "drwx------+ 3 moi staff 96 13 nov 08:00 /p\n 0: group:everyone deny delete\n 1: user:bob allow list,add_file,file_inherit,only_inherit\n" })("/p");
  assert.equal(mac.entrees.length, 2);
  assert.equal(mac.entrees[1].heritageSeul, true);
  assert.equal(sd.aclMac({ executer: () => "drwx------+ 3 moi staff 96 /p\n 0: ???\n" })("/p").lisible, false);
});

// --- Windows, simulé ---------------------------------------------------------

const U = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const AUTRE = "S-1-5-21-1111111111-2222222222-3333333333-1002";
const { SID, DROIT } = win;
const OI = 1, CI = 2, IO = 8, ID = 0x10;
const jetonSimule = (extra = {}) => ({ utilisateur: U, actifs: [SID.TOUT_LE_MONDE, SID.UTILISATEURS_AUTHENTIFIES, SID.UTILISATEURS], refus: [SID.ADMINISTRATEURS], tous: [SID.TOUT_LE_MONDE, SID.UTILISATEURS_AUTHENTIFIES, SID.UTILISATEURS, SID.ADMINISTRATEURS], certain: true, problemes: [], ...extra });
const ace = (type, sid, masque, drapeaux = 0) => ({ type, sid, masque, drapeaux });
const cible = (u = U) => [ace(0, u, DROIT.CONTROLE_TOTAL, OI | CI), ace(0, SID.SYSTEME, DROIT.CONTROLE_TOTAL, OI | CI), ace(0, SID.ADMINISTRATEURS, DROIT.CONTROLE_TOTAL, OI | CI)];

test("Windows (simulé) : droits effectifs calculés comme Windows", () => {
  const j = jetonSimule();
  const sec = (entrees, proprietaire = AUTRE) => ({ proprietaire, protegee: true, nulle: false, entrees });
  assert.equal(win.droitsEffectifs(sec([ace(0, U, DROIT.CONTROLE_TOTAL)]), j), DROIT.CONTROLE_TOTAL);
  assert.equal(win.droitsEffectifs(sec([ace(1, SID.TOUT_LE_MONDE, DROIT.AJOUT_FICHIER), ace(0, U, DROIT.CONTROLE_TOTAL)]), j) & DROIT.AJOUT_FICHIER, 0, "refus prioritaire");
  assert.equal(win.droitsEffectifs(sec([ace(0, U, DROIT.CONTROLE_TOTAL), ace(1, SID.TOUT_LE_MONDE, DROIT.AJOUT_FICHIER)]), j), DROIT.CONTROLE_TOTAL, "ordre de la liste : déjà accordé");
  assert.equal(win.droitsEffectifs(sec([ace(0, SID.ADMINISTRATEURS, DROIT.CONTROLE_TOTAL)]), j), 0, "Administrateurs réservé au refus : n'accorde rien");
  assert.equal(win.droitsEffectifs(sec([ace(1, SID.ADMINISTRATEURS, DROIT.LECTURE_DONNEES), ace(0, U, DROIT.CONTROLE_TOTAL)]), j) & DROIT.LECTURE_DONNEES, 0, "mais un refus sur Administrateurs s'applique");
  assert.equal(win.droitsEffectifs(sec([], U), j), DROIT.LECTURE_ACL | DROIT.MODIFICATION_ACL, "droits implicites du propriétaire");
  assert.equal(win.droitsEffectifs(sec([ace(0, SID.DROITS_DU_PROPRIETAIRE, DROIT.LECTURE_DONNEES)], U), j), DROIT.LECTURE_DONNEES, "OWNER RIGHTS remplace les droits implicites");
  assert.equal(win.droitsEffectifs(sec([ace(0, U, 0x80000000)]), j), 0x120089, "GENERIC_READ converti");
  assert.equal(win.droitsEffectifs(sec([ace(0, U, DROIT.CONTROLE_TOTAL, IO | OI)]), j), 0, "héritage seulement : ignoré pour l'objet");
  assert.equal(win.droitsEffectifs({ nulle: true }, j), DROIT.CONTROLE_TOTAL, "liste nulle : tout est permis");
});

test("Windows (simulé) : jeton — lectures réunies (certain) ; illisible ou utilisateur différent (incertain)", () => {
  const net = { utilisateur: U, actifs: [SID.TOUT_LE_MONDE, SID.UTILISATEURS], refus: [SID.ADMINISTRATEURS], refusConnu: true };
  const user = `"PC\\moi","${U}"\r\n`;
  const groupes = [`"Tout le monde","Groupe bien connu","${SID.TOUT_LE_MONDE}","Groupe obligatoire, Activé par défaut, Groupe activé"`, `"BUILTIN\\Utilisateurs","Alias","${SID.UTILISATEURS}","Groupe obligatoire"`, `"BUILTIN\\Administrateurs","Alias","${SID.ADMINISTRATEURS}","Groupe utilisé uniquement pour refuser"`, `"Étiquette obligatoire\\Niveau obligatoire moyen","Étiquette","S-1-16-8192",""`, `"AUTORITE NT\\Session","Groupe","S-1-5-5-0-123","Groupe obligatoire"`].join("\r\n");
  const j = win.construireJeton(net, user, groupes);
  assert.equal(j.certain, true, j.problemes.join(";"));
  assert.ok(j.refus.includes(SID.ADMINISTRATEURS));
  assert.ok(!j.tous.includes("S-1-16-8192") && !j.tous.includes("S-1-5-5-0-123"));
  // Groupe lu par .NET mais non affiché par whoami (cas réel : groupe local « Aucun », RID 513) : réuni, pas une incertitude.
  const aucun = "S-1-5-21-1111111111-2222222222-3333333333-513";
  const j2 = win.construireJeton({ ...net, actifs: [...net.actifs, aucun] }, user, groupes);
  assert.equal(j2.certain, true, j2.problemes.join(";"));
  assert.ok(j2.tous.includes(aucun) && j2.actifs.includes(aucun));
  assert.match(j2.notes.join(), /513/);
  assert.equal(win.construireJeton(net, null, groupes).certain, false, "whoami illisible");
  assert.equal(win.construireJeton(net, `"PC\\autre","${AUTRE}"`, groupes).certain, false, "utilisateur différent");
});

test("Windows (simulé) : conformité de la cible (dossier principal protégé, contenu en héritage pur)", () => {
  const j = jetonSimule();
  assert.equal(win.racineConforme({ protegee: true, entrees: cible() }, j), true);
  assert.equal(win.racineConforme({ protegee: false, entrees: cible() }, j), false, "héritage actif");
  assert.equal(win.racineConforme({ protegee: true, entrees: [...cible(), ace(0, SID.UTILISATEURS, 0x1200a9, OI | CI)] }, j), false, "un compte de trop");
  assert.equal(win.racineConforme({ protegee: true, entrees: cible().slice(0, 2) }, j), false, "Administrateurs manquant");
  const herite = cible().map((x) => ({ ...x, drapeaux: ID }));
  assert.equal(win.enfantConforme({ protegee: false, entrees: herite }, j), true);
  assert.equal(win.enfantConforme({ protegee: false, entrees: [...herite, ace(0, SID.TOUT_LE_MONDE, 0x120089)] }, j), false, "entrée explicite");
  assert.equal(win.enfantConforme({ protegee: true, entrees: herite }, j), false, "héritage coupé");
});

// Éléments simulés d'une inspection : chemin → sécurité.
const el = (chemin, securite, extra = {}) => ({ chemin, existe: true, dossier: true, reparse: false, securite: { nulle: false, ...securite }, ...extra });
const parentsSains = () => [
  el("C:\\", { proprietaire: SID.TRUSTED_INSTALLER, protegee: true, entrees: [ace(0, SID.ADMINISTRATEURS, DROIT.CONTROLE_TOTAL, OI | CI), ace(0, SID.SYSTEME, DROIT.CONTROLE_TOTAL, OI | CI), ace(0, SID.UTILISATEURS, 0x1200a9, OI | CI), ace(0, SID.UTILISATEURS_AUTHENTIFIES, 0x1301bf, OI | CI | IO), ace(0, SID.UTILISATEURS_AUTHENTIFIES, 0x4)] }),
  el("C:\\Users", { proprietaire: SID.SYSTEME, protegee: true, entrees: [ace(0, SID.SYSTEME, DROIT.CONTROLE_TOTAL, OI | CI), ace(0, SID.ADMINISTRATEURS, DROIT.CONTROLE_TOTAL, OI | CI), ace(0, SID.UTILISATEURS, 0x1200a9), ace(0, SID.TOUT_LE_MONDE, 0x1200a9)] }),
  el("C:\\Users\\moi", { proprietaire: SID.SYSTEME, protegee: true, entrees: cible() }),
  el("C:\\Users\\moi\\jurgenita", { proprietaire: U, protegee: false, entrees: cible().map((x) => ({ ...x, drapeaux: OI | CI | ID })) }),
  el("C:\\Users\\moi\\jurgenita\\data", { proprietaire: U, protegee: false, entrees: cible().map((x) => ({ ...x, drapeaux: OI | CI | ID })) }),
];
const SENSIBLE = "C:\\Users\\moi\\jurgenita\\data\\secrets";

test("Windows (simulé) : chaîne sûre dans le profil (C:\\ par défaut, C:\\Users, profil protégé)", () => {
  assert.deepEqual(win.analyserChaine({ sensible: SENSIBLE, elements: parentsSains(), jeton: jetonSimule(), noms: {} }), []);
});

test("Windows (simulé) : chaîne dangereuse — DELETE hérité, DELETE_CHILD, WRITE_DAC, WRITE_OWNER, propriétaire non fiable", () => {
  const sous = (modif) => { const e = parentsSains(); modif(e); return win.analyserChaine({ sensible: SENSIBLE, elements: e, jeton: jetonSimule(), noms: {} }); };
  const projets = sous((e) => { e[3].securite.entrees.push(ace(0, SID.UTILISATEURS_AUTHENTIFIES, 0x1301bf, OI | CI | ID)); });
  assert.ok(projets.some((p) => p.code === "parent_droits" && p.message.includes("(hérité)") && p.message.includes("DELETE")));
  const dc = sous((e) => { e[4].securite.entrees.push(ace(0, SID.UTILISATEURS, DROIT.SUPPRESSION_CONTENU)); });
  assert.ok(dc.some((p) => p.code === "parent_suppression_contenu" && p.message.includes("(explicite)")));
  assert.ok(sous((e) => { e[3].securite.entrees.push(ace(0, AUTRE, DROIT.MODIFICATION_ACL)); }).some((p) => p.message.includes("WRITE_DAC")));
  assert.ok(sous((e) => { e[3].securite.entrees.push(ace(0, AUTRE, DROIT.PRISE_PROPRIETE)); }).some((p) => p.message.includes("WRITE_OWNER")));
  assert.ok(sous((e) => { e[3].securite.proprietaire = AUTRE; }).some((p) => p.code === "parent_proprietaire"));
  for (const r of [projets, dc]) assert.deepEqual(niveaux(r), ["dangereux"]);
});

test("Windows (simulé) : chaîne incertaine — jonction, entrée conditionnelle, autorisations illisibles", () => {
  const sous = (modif) => { const e = parentsSains(); modif(e); return win.analyserChaine({ sensible: SENSIBLE, elements: e, jeton: jetonSimule(), noms: {} }); };
  assert.ok(sous((e) => { e[3].reparse = true; }).some((p) => p.code === "chaine_lien" && p.niveau === "incertain"));
  assert.ok(sous((e) => { e[4].securite.entrees.push({ type: 9, drapeaux: 0, masque: 0x1200a9, sid: SID.TOUT_LE_MONDE }); }).some((p) => p.code === "chaine_entree_inconnue"));
  assert.ok(sous((e) => { e[4] = { chemin: e[4].chemin, existe: true, erreur: "UnauthorizedAccessException" }; }).some((p) => p.code === "chaine_illisible"));
  assert.deepEqual(sous((e) => { e[4].securite.entrees.push(ace(0, SID.CREATEUR_PROPRIETAIRE, DROIT.CONTROLE_TOTAL)); }), [], "CREATOR OWNER ne correspond à aucun jeton");
});

test("Windows (simulé) : dossier sensible — toute règle de refus arrête (vous concerne ou non), accès d'autres comptes listés", () => {
  const j = jetonSimule();
  const items = (entreesFichier) => [el(SENSIBLE, { proprietaire: U, protegee: false, entrees: cible().map((x) => ({ ...x, drapeaux: OI | CI | ID })) }), el(`${SENSIBLE}\\brands`, { proprietaire: U, protegee: false, entrees: cible().map((x) => ({ ...x, drapeaux: OI | CI | ID })) }), el(`${SENSIBLE}\\brands\\kora.json`, { proprietaire: U, protegee: false, entrees: entreesFichier }, { dossier: false })];
  const herites = cible().map((x) => ({ ...x, drapeaux: ID }));
  const vous = win.analyserArbre({ racine: SENSIBLE, elements: items([ace(1, SID.UTILISATEURS, DROIT.AJOUT_FICHIER), ...herites]), jeton: j, noms: {} });
  assert.equal(vous.bloquant, true);
  assert.ok(vous.problemes.some((p) => p.code === "regle_de_refus" && p.vous === true));
  const autre = win.analyserArbre({ racine: SENSIBLE, elements: items([ace(1, "S-1-5-32-546", DROIT.LECTURE_DONNEES), ...herites]), jeton: j, noms: {} });
  assert.equal(autre.bloquant, true, "même un refus visant un autre compte arrête la correction");
  assert.ok(autre.problemes.some((p) => p.code === "regle_de_refus" && p.vous === false));
  const conditionnelle = win.analyserArbre({ racine: SENSIBLE, elements: items([{ type: 9, drapeaux: 0, masque: 0x1200a9, sid: SID.TOUT_LE_MONDE }, ...herites]), jeton: j, noms: {} });
  assert.ok(conditionnelle.problemes.some((p) => p.code === "entree_inconnue") && conditionnelle.bloquant);
  const ouvert = win.analyserArbre({ racine: SENSIBLE, elements: items([ace(0, SID.TOUT_LE_MONDE, 0x120089), ...herites]), jeton: j, noms: {} });
  assert.equal(ouvert.bloquant, false);
  assert.ok(ouvert.exposition.some((x) => x.sid === SID.TOUT_LE_MONDE));
  assert.ok(ouvert.aCorriger.includes(`${SENSIBLE}\\brands\\kora.json`));
});

// Modèle d'ACL Windows en mémoire : héritage, opérations, inspections, pannes.
function modeleWindows(initial, jeton) {
  const etat = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  const wp = path.win32;
  const effectives = (p) => {
    const it = etat.get(p);
    const herites = [];
    const parent = wp.dirname(p);
    if (!it.protegee && parent !== p && (etat.has(parent) || it.heritesExternes)) {
      const source = etat.has(parent) ? effectives(parent) : it.heritesExternes;
      for (const a of source) {
        if (a.drapeaux & (it.dossier ? CI : OI)) herites.push({ ...a, drapeaux: (it.dossier ? a.drapeaux & (OI | CI) : 0) | ID });
      }
    }
    return [...it.explicites, ...herites];
  };
  const securite = (p) => ({ proprietaire: etat.get(p).proprietaire, protegee: etat.get(p).protegee, nulle: false, entrees: effectives(p), sddl: `JSON:${JSON.stringify({ protegee: etat.get(p).protegee, explicites: etat.get(p).explicites })}` });
  const journal = [];
  let panne = () => false;
  const ps = async (nom, env) => {
    if (nom === "inspecter") {
      const e = JSON.parse(env.JG_ENTREE);
      return { ok: true, jeton: { utilisateur: jeton.utilisateur, actifs: jeton.actifs, refus: jeton.refus }, chemins: [], noms: {}, arbres: e.arbres.map((r) => ({ racine: r, volume: { format: "NTFS", type: "Fixed" }, elements: [...etat.keys()].filter((k) => k === r || k.startsWith(`${r}\\`)).map((k) => ({ chemin: k, existe: true, dossier: etat.get(k).dossier, reparse: false, securite: securite(k) })) })) };
    }
    const { ops } = JSON.parse(env.JG_OPERATIONS);
    const resultats = [];
    for (const op of ops) {
      journal.push(`${op.action}:${op.sddl?.startsWith("JSON:") ? "restauration" : op.sddl === win.SDDL_HERITAGE_SEUL ? "heritage" : op.sddl ? "cible" : "proprietaire"}:${op.chemin}`);
      if (panne(op)) { resultats.push({ ok: false, erreur: "PanneSimulee" }); break; }
      const it = etat.get(op.chemin);
      if (op.action === "proprietaire") it.proprietaire = op.sid;
      else if (op.sddl.startsWith("JSON:")) Object.assign(it, JSON.parse(op.sddl.slice(5)));
      else if (op.sddl === win.SDDL_HERITAGE_SEUL) Object.assign(it, { protegee: false, explicites: [] });
      else Object.assign(it, { protegee: true, explicites: cible(jeton.utilisateur) });
      resultats.push({ ok: true });
    }
    return { ok: true, resultats };
  };
  const instantane = () => Object.fromEntries([...etat.keys()].map((k) => [k, securite(k)]));
  return { ps, etat, journal, instantane, definirPanne: (f) => { panne = f; } };
}
const FS_NUL = { readdirSync: () => [], readFileSync: () => "", openSync: () => 1, closeSync: () => {}, unlinkSync: () => {} };
function scenarioWindows() {
  const j = jetonSimule();
  const R = "C:\\Users\\moi\\jurgenita\\data\\secrets";
  const externes = [...cible().map((x) => ({ ...x, drapeaux: OI | CI })), ace(0, SID.UTILISATEURS, 0x1200a9, OI | CI)];
  const m = modeleWindows({
    [R]: { dossier: true, proprietaire: U, protegee: false, explicites: [ace(0, SID.TOUT_LE_MONDE, 0x120089, OI | CI)], heritesExternes: externes },
    [`${R}\\brands`]: { dossier: true, proprietaire: AUTRE, protegee: true, explicites: [ace(0, U, DROIT.CONTROLE_TOTAL, OI | CI), ace(0, AUTRE, DROIT.CONTROLE_TOTAL, OI | CI)] },
    [`${R}\\brands\\kora.json`]: { dossier: false, proprietaire: U, protegee: false, explicites: [ace(0, "S-1-5-32-546", 0x120089)] },
    [`${R}\\google-token.json`]: { dossier: false, proprietaire: U, protegee: false, explicites: [] },
  }, j);
  return { j, R, m };
}
async function elementsDe(m, R) { return (await win.inspecter(m.ps, { arbres: [R] })).arbres[0].elements; }

test("Windows (simulé) : application dans l'ordre (propriétaires, dossier principal, contenu du haut vers le bas) puis vérification", async () => {
  const { j, R, m } = scenarioWindows();
  const r = await win.protegerArbre({ racine: R, elements: await elementsDe(m, R), jeton: j, ps: m.ps, fsImpl: FS_NUL });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(m.journal, [`proprietaire:proprietaire:${R}\\brands`, `dacl:cible:${R}`, `dacl:heritage:${R}\\brands`, `dacl:heritage:${R}\\google-token.json`, `dacl:heritage:${R}\\brands\\kora.json`]);
  const apres = m.instantane();
  assert.equal(win.racineConforme(apres[R], j), true);
  for (const k of Object.keys(apres).filter((k) => k !== R)) assert.equal(win.enfantConforme(apres[k], j), true, k);
});

test("Windows (simulé) : panne après le dossier principal → restauration (contenu d'abord, du plus profond, puis dossier principal) à l'identique", async () => {
  const { j, R, m } = scenarioWindows();
  const origine = m.instantane();
  m.definirPanne((op) => op.chemin === `${R}\\brands\\kora.json` && op.sddl === win.SDDL_HERITAGE_SEUL);
  const r = await win.protegerArbre({ racine: R, elements: await elementsDe(m, R), jeton: j, ps: m.ps, fsImpl: FS_NUL });
  assert.equal(r.ok, false);
  assert.equal(r.restauration.ok, true, JSON.stringify(r.restauration));
  const restaurations = m.journal.slice(m.journal.indexOf(`dacl:heritage:${R}\\brands\\kora.json`) + 1);
  assert.deepEqual(restaurations, [
    `dacl:restauration:${R}\\brands\\kora.json`, // le plus profond d'abord
    `proprietaire:proprietaire:${R}\\brands`, // propriétaire modifié : rétabli avant ses droits
    `dacl:restauration:${R}\\brands`,
    `dacl:restauration:${R}\\google-token.json`,
    `dacl:restauration:${R}`, // dossier principal en dernier
  ]);
  const apres = m.instantane();
  for (const k of Object.keys(origine)) assert.ok(win.memesDroits(apres[k], origine[k]), `${k} restauré à l'identique (entrées héritées comprises)`);
});

test("Windows (simulé) : panne pendant la restauration d'un élément contenu → dossier principal NON restauré, resté protégé", async () => {
  const { j, R, m } = scenarioWindows();
  m.definirPanne((op) => (op.chemin === `${R}\\brands` && op.sddl === win.SDDL_HERITAGE_SEUL) || (op.chemin === `${R}\\brands\\kora.json` && op.sddl?.startsWith("JSON:")));
  const r = await win.protegerArbre({ racine: R, elements: await elementsDe(m, R), jeton: j, ps: m.ps, fsImpl: FS_NUL });
  assert.equal(r.ok, false);
  assert.equal(r.restauration.etat, "restauration_partielle");
  assert.ok(!m.journal.includes(`dacl:restauration:${R}`), "le dossier principal n'est pas restauré");
  assert.equal(win.racineConforme(m.instantane()[R], j), true, "il reste protégé : vous gardez l'accès");
});

test("Windows (simulé) : panne pendant la restauration du dossier principal → état critique signalé", async () => {
  const { j, R, m } = scenarioWindows();
  m.definirPanne((op) => (op.chemin === `${R}\\brands\\kora.json` && op.sddl === win.SDDL_HERITAGE_SEUL) || (op.chemin === R && op.sddl?.startsWith("JSON:")));
  const r = await win.protegerArbre({ racine: R, elements: await elementsDe(m, R), jeton: j, ps: m.ps, fsImpl: FS_NUL });
  assert.equal(r.restauration.etat, "critique");
});

test("Windows (simulé) : diagnostic en fin de reprise — refus permanent, verrou, incertitude", async () => {
  const j = { utilisateur: U, actifs: [SID.UTILISATEURS], refus: [], refusConnu: true };
  const who = async (a) => (a[0] === "/user" ? `"PC\\moi","${U}"` : `"BUILTIN\\Utilisateurs","Alias","${SID.UTILISATEURS}","x"`);
  const dossier = (entrees) => el("C:\\s\\brands", { proprietaire: SID.SYSTEME, protegee: false, entrees });
  const fichier = el("C:\\s\\brands\\kora.json", { proprietaire: U, protegee: false, entrees: [ace(0, U, DROIT.CONTROLE_TOTAL, ID)] }, { dossier: false });
  const ps = (r) => async () => ({ ok: true, jeton: j, fichier, ...r });
  assert.equal(await win.diagnostiquerAcces("C:\\s\\brands\\kora.json", { ps: ps({ dossier: dossier([ace(1, U, DROIT.AJOUT_FICHIER), ace(0, U, DROIT.CONTROLE_TOTAL, ID)]), ouverture: "ok" }), whoami: who }), "refuse");
  assert.equal(await win.diagnostiquerAcces("C:\\s\\brands\\kora.json", { ps: ps({ dossier: dossier([ace(0, U, DROIT.CONTROLE_TOTAL, ID)]), ouverture: "occupe" }), whoami: who }), "verrou");
  assert.equal(await win.diagnostiquerAcces("C:\\s\\brands\\kora.json", { ps: ps({ dossier: dossier([ace(0, U, DROIT.CONTROLE_TOTAL, ID)]), ouverture: "refuse" }), whoami: who }), "incertain", "calcul et noyau en désaccord");
  assert.equal(await win.diagnostiquerAcces("C:\\x", { ps: async () => ({ ok: false }), whoami: who }), "incertain");
});

test("outils Windows : chemins complets sous SystemRoot, jamais résolus par le PATH", () => {
  const avant = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
  try {
    process.env.SystemRoot = "D:\\Win";
    assert.equal(win.cheminWhoami(), "D:\\Win\\System32\\whoami.exe");
    assert.equal(win.cheminPowerShell(), "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    delete process.env.SystemRoot;
    delete process.env.windir;
    assert.equal(win.cheminWhoami(), "C:\\Windows\\System32\\whoami.exe");
  } finally {
    for (const [k, v] of Object.entries(avant)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("scripts PowerShell : aucun guillemet double, aucun accent grave, ASCII, taille compatible avec la ligne de commande", () => {
  for (const [nom, script] of Object.entries(win.SCRIPTS)) {
    assert.equal((script.match(/"/g) || []).length, 0, nom);
    assert.equal((script.match(/`/g) || []).length, 0, nom);
    assert.equal((script.match(/[^\x00-\x7f]/g) || []).length, 0, nom);
    assert.ok(script.length < 16000, nom);
  }
});

// ===========================================================================
// LINUX ET MACOS RÉELS
// ===========================================================================

async function demarrer({ secrets, rt, env = {} }) {
  const enfant = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, PORT: "0", JURGENITA_DEMO: "1", JURGENITA_NO_SCHEDULER: "1", JURGENITA_SECRETS_DIR: secrets, JURGENITA_RUNTIME_DIR: rt, META_ACCESS_TOKEN: "", TIKTOK_ACCESS_TOKEN: "", LINKEDIN_ACCESS_TOKEN: "", TELEGRAM_BOT_TOKEN: "", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", JURGENITA_SECRETS_PERMISSIONS: "", ...env },
  });
  let journal = "";
  enfant.stdout.on("data", (c) => (journal += c));
  enfant.stderr.on("data", (c) => (journal += c));
  const port = await new Promise((resolve, reject) => {
    enfant.stdout.on("data", () => { const m = journal.match(/http:\/\/[\d.]+:(\d+)/); if (m) resolve(Number(m[1])); });
    enfant.on("exit", (code) => reject(new Error(`serveur arrêté (${code}) :\n${journal}`)));
  });
  return { port, journal: () => journal, arreter: () => enfant.kill() };
}
function appel(port, methode, chemin, corps, marque = "kora") {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request({ host: "127.0.0.1", port, method: methode, path: chemin, headers: { "content-type": "application/json", "x-marque": marque } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let json = null; try { json = JSON.parse(d); } catch { /* */ } resolve({ status: res.statusCode, corps: json, texte: d, ms: Date.now() - t0 }); });
    });
    req.on("error", reject);
    if (corps) req.write(JSON.stringify(corps));
    req.end();
  });
}
const protection = async (port) => (await appel(port, "GET", "/api/status")).corps.connexions.protection_secrets;
function installation(nom) {
  const b = base(nom);
  const data = path.join(b, "data");
  fs.mkdirSync(data, { mode: 0o755 });
  fs.chmodSync(data, 0o755);
  return { b, data, secrets: path.join(data, "secrets"), sauvegardes: path.join(data, sd.NOM_SAUVEGARDES), rt: path.join(b, "rt") };
}

test("POSIX (réel) : première exécution — dossier des secrets créé en 700, accès en 600, aucune sauvegarde inutile", surPosix, async () => {
  const i = installation("neuf");
  const srv = await demarrer(i);
  try {
    assert.equal(mode(i.secrets), 0o700);
    const p = await protection(srv.port);
    assert.equal(p.niveau, "sur");
    assert.equal(p.etat, "protege");
    assert.equal((await appel(srv.port, "PUT", "/api/brand/connexions", { meta_page_id: "page-1" })).status, 200);
    assert.equal(mode(path.join(i.secrets, "brands")), 0o700);
    assert.equal(mode(path.join(i.secrets, "brands", "kora.json")), 0o600);
    assert.equal(fs.existsSync(i.sauvegardes), false, "rien à corriger : aucune sauvegarde");
  } finally { srv.arreter(); }
});

test("POSIX (réel) : droits trop larges — resserrés au démarrage, contenu identique, sauvegarde écrite avant, en 700/600", surPosix, async () => {
  const i = installation("ouvert");
  fs.mkdirSync(path.join(i.secrets, "brands"), { recursive: true });
  const kora = path.join(i.secrets, "brands", "kora.json");
  const jeton = path.join(i.secrets, "google-token.json");
  fs.writeFileSync(kora, JSON.stringify({ tiktok_token: "tkFactice2b4AbCdEfGh" }));
  fs.writeFileSync(jeton, JSON.stringify({ refresh_token: "1//factice2b4" }));
  fs.chmodSync(i.secrets, 0o777); fs.chmodSync(path.join(i.secrets, "brands"), 0o755); fs.chmodSync(kora, 0o666); fs.chmodSync(jeton, 0o644);
  const avant = { kora: empreinte(kora), jeton: empreinte(jeton) };
  const srv = await demarrer(i);
  try {
    assert.equal(mode(i.secrets), 0o700);
    assert.equal(mode(path.join(i.secrets, "brands")), 0o700);
    assert.equal(mode(kora), 0o600);
    assert.equal(mode(jeton), 0o600);
    assert.deepEqual({ kora: empreinte(kora), jeton: empreinte(jeton) }, avant, "contenu identique");
    assert.equal(mode(i.sauvegardes), 0o700);
    const [sauvegarde] = fs.readdirSync(i.sauvegardes).filter((f) => f.endsWith(".json"));
    assert.equal(mode(path.join(i.sauvegardes, sauvegarde)), 0o600);
    const contenu = JSON.parse(fs.readFileSync(path.join(i.sauvegardes, sauvegarde), "utf8"));
    assert.deepEqual(Object.fromEntries(contenu.elements.map((e) => [e.chemin, e.mode])), { ".": "777", brands: "755", "brands/kora.json": "666", "google-token.json": "644" });
    assert.ok(!JSON.stringify(contenu).includes("tkFactice2b4"), "aucun secret dans la sauvegarde");
    const p = await protection(srv.port);
    assert.equal(p.etat, "corrige");
    assert.equal(p.niveau, "sur");
    assert.equal(p.corrections.length, 4);
    assert.ok(!JSON.stringify(p).includes("tkFactice2b4") && !srv.journal().includes("tkFactice2b4"), "aucun secret dans le rapport ni le journal");
  } finally { srv.arreter(); }
});

test("POSIX (réel) : lecture seule respectée — 444 devient 400, aucun droit ajouté", surPosix, async () => {
  const i = installation("lecture-seule");
  fs.mkdirSync(i.secrets, { mode: 0o700 });
  fs.chmodSync(i.secrets, 0o700);
  const f = path.join(i.secrets, "fige.json");
  fs.writeFileSync(f, "{}");
  fs.chmodSync(f, 0o444);
  const r = await sdAvec(i, () => sd.ensureSecretsDir());
  assert.equal(r.etat, "corrige");
  assert.equal(mode(f), 0o400);
});

async function sdAvec(i, fn, env = {}) {
  const avant = { ...process.env };
  Object.assign(process.env, { JURGENITA_SECRETS_DIR: i.secrets, JURGENITA_SECRETS_PERMISSIONS: "", ...env });
  delete process.env.JURGENITA_SECRETS_BACKUP_DIR;
  try { return await fn(); } finally {
    for (const k of ["JURGENITA_SECRETS_DIR", "JURGENITA_SECRETS_PERMISSIONS", "JURGENITA_SECRETS_BACKUP_DIR"]) if (avant[k] === undefined) delete process.env[k]; else process.env[k] = avant[k];
  }
}

test("POSIX (réel) : mode verifier — aucune écriture, situation dangereuse signalée", surPosix, async () => {
  const i = installation("verifier");
  fs.mkdirSync(i.secrets);
  const f = path.join(i.secrets, "kora.json");
  fs.writeFileSync(f, "{}");
  fs.chmodSync(i.secrets, 0o755); fs.chmodSync(f, 0o644);
  const avant = { dossier: fs.statSync(i.secrets).mtimeMs, fichier: fs.statSync(f).mtimeMs };
  const r = await sdAvec(i, () => sd.ensureSecretsDir(), { JURGENITA_SECRETS_PERMISSIONS: "verifier" });
  assert.equal(r.etat, "verification_seule");
  assert.equal(r.niveau, "dangereux");
  assert.ok(r.problemes.some((p) => p.code === "droits_trop_larges"));
  assert.equal(mode(i.secrets), 0o755);
  assert.equal(mode(f), 0o644);
  assert.deepEqual({ dossier: fs.statSync(i.secrets).mtimeMs, fichier: fs.statSync(f).mtimeMs }, avant);
  assert.equal(fs.existsSync(i.sauvegardes), false, "pas de dossier des sauvegardes créé");
});

test("POSIX (réel) : parent modifiable par tous sans bit sticky → correction interrompue, parent jamais modifié", surPosix, async () => {
  const i = installation("parent-ouvert");
  fs.mkdirSync(i.secrets);
  fs.chmodSync(i.secrets, 0o755);
  fs.chmodSync(i.data, 0o777);
  const r = await sdAvec(i, () => sd.ensureSecretsDir());
  assert.equal(r.etat, "correction_interrompue");
  assert.equal(r.niveau, "dangereux");
  assert.ok(r.problemes.some((p) => p.code === "parent_modifiable_par_tous"));
  assert.equal(mode(i.data), 0o777, "parent intact");
  assert.equal(mode(i.secrets), 0o755, "rien corrigé");
  assert.ok(r.fonctionnalites.some((f) => f.includes("remplacer le dossier des secrets")));
});

test("POSIX (réel) : parent partagé avec bit sticky → pas vulnérable en soi, correction faite", surPosix, async () => {
  const i = installation("sticky");
  fs.mkdirSync(i.secrets);
  fs.chmodSync(i.secrets, 0o755);
  fs.chmodSync(i.data, 0o1777);
  const r = await sdAvec(i, () => sd.ensureSecretsDir());
  assert.equal(r.etat, "corrige", JSON.stringify(r.problemes));
  assert.equal(mode(i.secrets), 0o700);
  assert.equal(mode(i.data), 0o1777, "parent intact");
});

test("POSIX (réel) : lien symbolique à la place du dossier des secrets → aucune correction à travers lui", surPosix, async () => {
  const i = installation("lien");
  const vrai = path.join(i.b, "ailleurs");
  fs.mkdirSync(vrai, { mode: 0o755 });
  fs.chmodSync(vrai, 0o755);
  fs.symlinkSync(vrai, i.secrets);
  const r = await sdAvec(i, () => sd.ensureSecretsDir());
  assert.equal(r.etat, "correction_interrompue");
  assert.ok(r.problemes.some((p) => p.code === "lien_symbolique" && p.niveau === "incertain"));
  assert.equal(mode(vrai), 0o755);
});

test("POSIX (réel) : dossier interdit — démarrage normal, 409 immédiat (pas « verrouillé »), droits jamais élargis", surPosixNonRoot, async () => {
  const i = installation("interdit");
  fs.mkdirSync(path.join(i.secrets, "brands"), { recursive: true });
  fs.writeFileSync(path.join(i.secrets, "brands", "kora.json"), "{}");
  fs.chmodSync(path.join(i.secrets, "brands", "kora.json"), 0o600);
  fs.chmodSync(path.join(i.secrets, "brands"), 0o700);
  fs.chmodSync(i.secrets, 0o000);
  const srv = await demarrer(i);
  try {
    const p = await protection(srv.port);
    assert.equal(p.acces, "refuse");
    assert.ok(p.fonctionnalites.some((f) => f.includes("Indisponibles")));
    const r = await appel(srv.port, "PUT", "/api/brand/connexions", { meta_page_id: "x" });
    assert.equal(r.status, 409, r.texte);
    assert.ok(r.ms < 2000, `réponse en ${r.ms} ms`);
    assert.match(r.corps.erreur, /Accès refusé/);
    assert.doesNotMatch(r.corps.erreur, /verrouill/);
    assert.equal(mode(i.secrets), 0o000, "aucun droit ajouté automatiquement");
    assert.ok(p.actions.some((x) => x.includes("chmod -R u+rwX")), "le dossier est à vous : rendre ses droits au propriétaire");
    assert.ok(!p.actions.some((x) => x.includes("chown")), JSON.stringify(p.actions));
  } finally { srv.arreter(); fs.chmodSync(i.secrets, 0o700); }
});

test("POSIX (réel, root) : dossier des secrets appartenant à un autre compte → dangereux, aucune correction", surPosixRoot, async () => {
  const i = installation("etranger");
  fs.mkdirSync(i.secrets);
  fs.chmodSync(i.secrets, 0o755);
  fs.chownSync(i.secrets, 65534, 65534);
  const r = await sdAvec(i, () => sd.ensureSecretsDir());
  assert.equal(r.etat, "correction_interrompue");
  assert.ok(r.problemes.some((p) => p.code === "proprietaire_etranger" && p.niveau === "dangereux"));
  assert.equal(mode(i.secrets), 0o755);
  assert.ok(r.actions.some((a) => a.includes("chown")));
});

test("POSIX (réel) : .env — contrôle informatif seulement, jamais modifié", surPosix, async () => {
  const i = installation("env");
  const env = path.join(i.b, ".env");
  fs.writeFileSync(env, "ANTHROPIC_API_KEY=sk-ant-factice\n");
  fs.chmodSync(env, 0o644);
  const avant = { mode: mode(env), contenu: empreinte(env), mtime: fs.statSync(env).mtimeMs };
  const r = await sdAvec(i, () => sd.ensureSecretsDir({ env }));
  assert.equal(r.env.niveau, "info");
  assert.match(r.env.message, /644/);
  assert.match(r.env.action, /chmod 600 \.env/);
  assert.match(r.env.action, /non appliqué automatiquement/);
  assert.deepEqual({ mode: mode(env), contenu: empreinte(env), mtime: fs.statSync(env).mtimeMs }, avant);
  assert.ok(!JSON.stringify(r).includes("sk-ant-factice"));
});

test("POSIX (réel) : dossier supprimé pendant l'exécution → recréé protégé avant d'écrire", surPosix, async () => {
  const i = installation("recree");
  const srv = await demarrer(i);
  try {
    fs.rmSync(i.secrets, { recursive: true, force: true });
    assert.equal((await appel(srv.port, "PUT", "/api/brand/connexions", { meta_page_id: "p" })).status, 200);
    assert.equal(mode(i.secrets), 0o700);
    assert.equal(mode(path.join(i.secrets, "brands", "kora.json")), 0o600);
  } finally { srv.arreter(); }
});

test("POSIX (réel) : restauration manuelle — aperçu sans effet, application dans l'ordre, refus si la sauvegarde est exposée", surPosix, async () => {
  const i = installation("restauration");
  fs.mkdirSync(path.join(i.secrets, "brands"), { recursive: true });
  const f = path.join(i.secrets, "brands", "kora.json");
  fs.writeFileSync(f, "{}");
  fs.chmodSync(i.secrets, 0o755); fs.chmodSync(path.join(i.secrets, "brands"), 0o755); fs.chmodSync(f, 0o644);
  await sdAvec(i, () => sd.ensureSecretsDir());
  const [nom] = fs.readdirSync(i.sauvegardes);
  const script = (...a) => spawnSync(process.execPath, [path.join(root, "scripts", "restaurer-droits-secrets.mjs"), path.join(i.sauvegardes, nom), ...a], { encoding: "utf8", env: { ...process.env, JURGENITA_SECRETS_DIR: i.secrets } });
  const apercu = script();
  assert.equal(apercu.status, 0, apercu.stderr);
  assert.match(apercu.stdout, /Aperçu seulement/);
  assert.equal(mode(f), 0o600, "aperçu : rien modifié");
  const lignes = apercu.stdout.split("\n").filter((l) => l.includes("→ droits"));
  assert.deepEqual(lignes.map((l) => l.trim().split(" ")[1]), ["brands/kora.json", "brands", "."], "contenu d'abord, dossier principal en dernier");
  const app = script("--appliquer");
  assert.equal(app.status, 0, app.stderr);
  assert.deepEqual([mode(i.secrets), mode(path.join(i.secrets, "brands")), mode(f)], [0o755, 0o755, 0o644]);
  fs.chmodSync(i.sauvegardes, 0o755);
  const refus = script("--appliquer");
  assert.equal(refus.status, 4);
  assert.match(refus.stderr, /Restauration refusée par prudence/);
});

// ===========================================================================
// MACOS SEUL
// ===========================================================================

test("macOS (réel) : ACL étendue accordant la lecture à un autre compte → signalée, jamais retirée", surMac, async () => {
  const i = installation("acl-mac");
  fs.mkdirSync(i.secrets, { mode: 0o700 });
  fs.chmodSync(i.secrets, 0o700);
  const f = path.join(i.secrets, "kora.json");
  fs.writeFileSync(f, "{}");
  fs.chmodSync(f, 0o600);
  assert.equal(spawnSync("chmod", ["+a", "group:everyone allow read", f]).status, 0);
  const r = await sdAvec(i, () => sd.ensureSecretsDir());
  assert.ok(r.problemes.some((p) => p.code === "acl_macos" && p.niveau === "dangereux"), JSON.stringify(r.problemes));
  assert.match(spawnSync("ls", ["-le", f], { encoding: "utf8" }).stdout, /everyone allow read/, "ACL conservée");
});
