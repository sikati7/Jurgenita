// Protection des dossiers de secrets (sous-étape 2b.4).
//
// - Chemins centralisés : dossier des secrets, accès des marques, jeton Google,
//   dossier des sauvegardes de droits (à côté du dossier des secrets, jamais
//   dedans), fichier .env.
// - Vérification au démarrage, et correction automatique UNIQUEMENT par
//   resserrement (Linux et macOS : dossiers & 700, fichiers & 600 ; Windows :
//   héritage coupé, contrôle total pour l'utilisateur, SYSTEM et
//   Administrateurs). Jamais d'élargissement, jamais de modification des
//   dossiers parents, jamais de modification de .env (contrôle informatif).
// - Toute situation dangereuse ou incertaine dans la chaîne des parents, ou
//   toute incertitude d'analyse, interrompt la correction automatique.
// - Sauvegarde des droits avant toute correction, dans un dossier protégé
//   extérieur au dossier corrigé.
// - JURGENITA_SECRETS_PERMISSIONS=verifier : inspection sans aucune écriture.
// - Le rapport ne contient jamais de secret ; il distingue « sûr »,
//   « incertain » et « dangereux ».
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeJsonAtomicAsync } from "./atomic-file.js";
import * as win from "./secret-dir-windows.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEPOT = path.join(here, "..");
export const NOM_SAUVEGARDES = "secret-permissions-backups";

// ---------------------------------------------------------------------------
// Chemins (seule source de vérité ; google.js garde son propre calcul,
// identique, vérifié par les tests)
// ---------------------------------------------------------------------------
export const secretsRoot = () => path.resolve(process.env.JURGENITA_SECRETS_DIR || path.join(DEPOT, "data", "secrets"));
export const brandsDir = () => path.join(secretsRoot(), "brands");
export const googleTokenFile = () => path.join(secretsRoot(), "google-token.json");
export const backupsDir = () => path.resolve(process.env.JURGENITA_SECRETS_BACKUP_DIR || path.join(path.dirname(secretsRoot()), NOM_SAUVEGARDES));
export const envFile = () => path.join(DEPOT, ".env");

export function modeProtection() {
  const v = String(process.env.JURGENITA_SECRETS_PERMISSIONS || "").trim().toLowerCase();
  if (!v || v === "corriger") return { mode: "corriger" };
  if (v === "verifier" || v === "vérifier") return { mode: "verifier" };
  // Valeur inconnue : la prudence l'emporte, rien n'est modifié.
  return { mode: "verifier", inconnu: v };
}

// Chemin lisible dans les rapports : relatif au dossier du projet quand c'est possible.
export function afficher(p) {
  const r = path.relative(DEPOT, p);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.split(path.sep).join("/") : p;
}

// Analyses Linux et macOS : chemins POSIX quel que soit le système qui les
// exécute (les tests simulés tournent aussi sous Windows).
const px = path.posix;
const NIVEAUX = { sur: 0, incertain: 1, dangereux: 2 };
const pire = (a, b) => (NIVEAUX[b] > NIVEAUX[a] ? b : a);
const octal = (m) => (m & 0o7777).toString(8).padStart(3, "0");

// ---------------------------------------------------------------------------
// Linux et macOS
// ---------------------------------------------------------------------------
export function vuePosix(fsImpl = fs) {
  return {
    lstat(p) {
      try {
        const s = fsImpl.lstatSync(p);
        return { mode: s.mode & 0o7777, uid: s.uid, gid: s.gid, dossier: s.isDirectory(), fichier: s.isFile(), lien: s.isSymbolicLink() };
      } catch (err) {
        return err.code === "ENOENT" || err.code === "ENOTDIR" ? null : { erreur: err.code || "erreur" };
      }
    },
    realpath(p) { try { return fsImpl.realpathSync(p); } catch { return null; } },
    readdir(p) { return fsImpl.readdirSync(p); },
    access(p, m) { try { fsImpl.accessSync(p, m); return true; } catch { return false; } },
  };
}

// Qui est l'utilisateur courant ?
export function moiPosix() {
  const info = os.userInfo();
  return { uid: process.getuid(), gid: process.getgid(), nom: info.username };
}

// Outils système : chemin complet quand il existe. Un homonyme placé plus tôt
// dans le PATH (par exemple le ls GNU sur macOS, qui ignore l'option -e) ne
// doit pas fausser l'analyse ; le PATH ne sert qu'en dernier recours.
const OUTILS = {
  ls: ["/bin/ls", "/usr/bin/ls"],
  getfacl: ["/usr/bin/getfacl", "/bin/getfacl"],
  getent: ["/usr/bin/getent", "/bin/getent"],
  dscl: ["/usr/bin/dscl"],
  dscacheutil: ["/usr/bin/dscacheutil"],
};
export const outil = (nom, existe = fs.existsSync) => (OUTILS[nom] || []).find((p) => existe(p)) || nom;
const executerOutil = (c, a) => execFileSync(outil(c), a, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });

// Membres d'un groupe (Linux). Certitude seulement si les annuaires de comptes
// sont purement locaux (fichiers), sans entrées NIS « + / - » ni
// enregistrements systemd-userdb de groupes. Sinon : incertain.
export function groupesLinux({ lire = (f) => fs.readFileSync(f, "utf8"), lister = (d) => fs.readdirSync(d) } = {}) {
  return (gid, moi) => {
    let nss = null;
    try { nss = lire("/etc/nsswitch.conf"); } catch { /* absent : fichiers seulement */ }
    const sources = (base) => {
      if (!nss) return ["files"];
      const ligne = nss.split("\n").map((l) => l.replace(/#.*/, "").trim()).find((l) => l.startsWith(`${base}:`));
      return ligne ? ligne.slice(base.length + 1).trim().split(/\s+/).filter((x) => x && !x.startsWith("[")) : ["files"];
    };
    const locales = new Set(["files", "compat", "systemd", "mymachines"]);
    for (const base of ["passwd", "group"]) {
      const autres = sources(base).filter((x) => !locales.has(x));
      if (autres.length) return { certain: false, raison: `annuaire ${base} non local (${autres.join(", ")})` };
    }
    for (const d of ["/etc/userdb", "/run/userdb", "/run/host/userdb", "/usr/lib/userdb", "/usr/local/lib/userdb"]) {
      try { if (lister(d).some((f) => /\.(group|membership)$/.test(f))) return { certain: false, raison: `groupes déclarés dans ${d}` }; } catch { /* absent */ }
    }
    let groupes, comptes;
    try { groupes = lire("/etc/group"); comptes = lire("/etc/passwd"); } catch { return { certain: false, raison: "annuaires locaux illisibles" }; }
    if (/^[+-]/m.test(groupes) || /^[+-]/m.test(comptes)) return { certain: false, raison: "entrées NIS dans les annuaires locaux" };
    const membres = new Set();
    for (const l of groupes.split("\n")) {
      const f = l.split(":");
      if (f.length >= 4 && Number(f[2]) === gid) f[3].split(",").map((x) => x.trim()).filter(Boolean).forEach((x) => membres.add(x));
    }
    for (const l of comptes.split("\n")) {
      const f = l.split(":");
      if (f.length >= 4 && Number(f[3]) === gid) membres.add(f[0]);
    }
    return { certain: true, autres: [...membres].filter((n) => n !== moi.nom && n !== "root") };
  };
}

// Membres d'un groupe (macOS). Certitude seulement si le chemin de recherche
// des comptes est purement local (/Local, /BSD) et si le groupe n'a pas de
// groupes imbriqués. Sinon : incertain.
export function lireCheminRecherche(sortie) {
  const lignes = String(sortie || "").split("\n");
  const i = lignes.findIndex((l) => l.startsWith("CSPSearchPath:"));
  if (i < 0) return null;
  const reste = lignes[i].slice("CSPSearchPath:".length).trim();
  // Une valeur par ligne (indentée) quand une valeur contient une espace ; sinon, sur la même ligne.
  const valeurs = reste ? reste.split(/\s+/) : lignes.slice(i + 1).filter((l) => /^\s/.test(l)).map((l) => l.trim()).filter(Boolean);
  return valeurs.length ? valeurs : null;
}
export function groupesMac({ executer = executerOutil } = {}) {
  return (gid, moi) => {
    try {
      const chemin = lireCheminRecherche(executer("dscl", ["/Search", "-read", "/", "CSPSearchPath"]));
      if (!chemin) return { certain: false, raison: "chemin de recherche des comptes illisible" };
      const distants = chemin.filter((n) => !n.startsWith("/Local/") && !n.startsWith("/BSD/"));
      if (distants.length) return { certain: false, raison: `annuaire réseau (${distants.join(", ")})` };
      const g = executer("dscacheutil", ["-q", "group", "-a", "gid", String(gid)]);
      const nomGroupe = /^name:\s*(\S+)\s*$/m.exec(g)?.[1];
      if (!nomGroupe) return { certain: false, raison: `groupe ${gid} introuvable` };
      if (/^NestedGroups:/m.test(executer("dscl", [".", "-read", `/Groups/${nomGroupe}`]))) return { certain: false, raison: `groupe ${nomGroupe} avec groupes imbriqués` };
      const membres = new Set((/^users:\s*(.*)$/m.exec(g)?.[1] || "").split(/\s+/).filter(Boolean));
      for (const l of executer("dscl", [".", "-list", "/Users", "PrimaryGroupID"]).split("\n")) {
        const [nom, id] = l.trim().split(/\s+/);
        if (nom && Number(id) === gid) membres.add(nom);
      }
      return { certain: true, autres: [...membres].filter((n) => n !== moi.nom && n !== "root") };
    } catch {
      return { certain: false, raison: "annuaire macOS illisible" };
    }
  };
}

// ACL étendues. Linux : présence (« + » dans ls -ld) puis getfacl.
export function aclLinux({ executer = executerOutil } = {}) {
  return (p) => {
    let ls;
    try { ls = executer("ls", ["-ld", "--", p]); } catch { return { lisible: false, raison: "ls indisponible" }; }
    if (!/^\S{10}\+/.test(ls)) return { lisible: true, presente: false };
    let sortie;
    try { sortie = executer("getfacl", ["-cp", "--", p]); } catch { return { lisible: false, presente: true, raison: "ACL présente mais getfacl indisponible" }; }
    const entrees = [];
    for (const l of sortie.split("\n").map((x) => x.trim()).filter(Boolean)) {
      const m = /^(user|group|mask|other):([^:]*):([rwx-]{3})(?:\s+#effective:([rwx-]{3}))?$/.exec(l);
      if (!m) return { lisible: false, presente: true, raison: "ACL illisible" };
      entrees.push({ type: m[1], nom: m[2], droits: m[4] || m[3] });
    }
    return { lisible: true, presente: true, entrees };
  };
}

// ACL macOS (indépendantes des bits de mode) : lues avec ls -led.
export function aclMac({ executer = executerOutil } = {}) {
  return (p) => {
    let sortie;
    try { sortie = executer("ls", ["-led", "--", p]); } catch { return { lisible: false, raison: "ls indisponible" }; }
    const entrees = [];
    for (const l of sortie.split("\n").slice(1).map((x) => x.trim()).filter(Boolean)) {
      const m = /^\d+:\s+(user|group):(\S+)\s+(?:inherited\s+)?(allow|deny)\s+(\S+)$/.exec(l);
      if (!m) return { lisible: false, raison: "ACL illisible" };
      const droits = m[4].split(",");
      entrees.push({ principal: m[1], nom: m[2], autoriser: m[3] === "allow", droits, heritageSeul: droits.includes("only_inherit") });
    }
    return { lisible: true, presente: entrees.length > 0, entrees };
  };
}

// Chaîne des parents (Linux, macOS) : un compte non fiable (ni vous, ni root)
// peut-il remplacer, supprimer, renommer un élément de la chaîne, ou en
// modifier les permissions ? Un dossier « sticky » n'est pas vulnérable en
// soi : seuls le propriétaire de l'élément, celui du dossier ou root peuvent
// alors renommer ou supprimer l'élément.
export function analyserChainePosix({ sensible, vue, moi, groupe, acl, plateforme }) {
  const problemes = [];
  const fiable = (uid) => uid === 0 || uid === moi.uid;
  const absolu = px.resolve(sensible);
  let existant = absolu;
  while (!vue.lstat(existant) && px.dirname(existant) !== existant) existant = px.dirname(existant);
  const reel = vue.realpath(existant);
  if (!reel) return [{ niveau: "incertain", code: "chaine_illisible", message: `Chemin réel de ${existant} introuvable.` }];
  const sensibleExiste = existant === absolu;
  // Éléments à évaluer (chemins réels) : le dossier sensible (même futur) puis chaque parent.
  const cibles = [];
  let cur = sensibleExiste ? reel : px.join(reel, px.relative(existant, absolu));
  for (;;) {
    const parent = px.dirname(cur);
    if (parent === cur) break;
    cibles.push({ cible: cur, parent });
    cur = parent;
  }
  // Liens symboliques du chemin logique : leur remplacement dépend du dossier qui les contient.
  let pre = px.parse(absolu).root;
  for (const morceau of absolu.slice(pre.length).split(px.sep).filter(Boolean)) {
    const suivant = px.join(pre, morceau);
    const s = vue.lstat(suivant);
    if (!s) break;
    if (s.lien) {
      const contenant = vue.realpath(px.dirname(suivant));
      if (!contenant) problemes.push({ niveau: "incertain", code: "chaine_illisible", message: `Dossier contenant le lien ${suivant} introuvable.` });
      else cibles.push({ cible: suivant, parent: contenant, lien: true });
    }
    pre = suivant;
  }
  const vus = new Set();
  for (const { cible, parent, lien } of cibles) {
    const cle = `${cible}|${parent}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    const estSensible = !lien && cible === (sensibleExiste ? reel : px.join(reel, px.relative(existant, absolu)));
    const se = vue.lstat(cible);
    const sp = vue.lstat(parent);
    if (!sp || sp.erreur || !sp.dossier) { problemes.push({ niveau: "incertain", code: "chaine_illisible", message: `Dossier parent ${parent} illisible.` }); continue; }
    if (se?.erreur) { problemes.push({ niveau: "incertain", code: "chaine_illisible", message: `${cible} illisible (${se.erreur}).` }); continue; }
    // Propriétaire non fiable : peut changer les permissions (et donc tout le reste).
    if (se && !estSensible && !fiable(se.uid)) problemes.push({ niveau: "dangereux", code: "parent_proprietaire", message: `${cible} appartient à un autre compte (uid ${se.uid}), qui peut en changer les permissions.` });
    if (!fiable(sp.uid)) problemes.push({ niveau: "dangereux", code: "parent_proprietaire", message: `${parent} appartient à un autre compte (uid ${sp.uid}), qui peut en changer les permissions.` });
    const sticky = (sp.mode & 0o1000) !== 0;
    // Avec le bit sticky, seuls le propriétaire de l'élément, celui du dossier
    // et root peuvent renommer ou supprimer l'élément.
    const protegeParSticky = sticky && fiable(sp.uid) && (!se || fiable(se.uid));
    const quoi = estSensible ? "remplacer le dossier sensible" : `renommer ou remplacer ${cible}`;
    // Autres : écriture + traversée.
    if ((sp.mode & 0o003) === 0o003 && !protegeParSticky) {
      problemes.push({ niveau: "dangereux", code: "parent_modifiable_par_tous", message: `${parent} est modifiable par tous les comptes (droits ${octal(sp.mode)}, sans bit sticky) : n'importe qui peut ${quoi}.` });
    }
    // Groupe (et ACL étendues).
    if (plateforme === "linux") {
      if ((sp.mode & 0o030) === 0o030) {
        const a = acl(parent);
        if (!a.lisible) problemes.push({ niveau: "incertain", code: "acl_incertaine", message: `${parent} : ${a.raison}.` });
        else if (!protegeParSticky) {
          const masque = a.presente ? a.entrees.find((x) => x.type === "mask")?.droits || "rwx" : "rwx";
          const ecrit = (d) => d[1] === "w" && d[2] === "x" && masque[1] === "w" && masque[2] === "x";
          const groupes = [];
          if (!a.presente) groupes.push({ gid: sp.gid, libelle: `groupe ${sp.gid}` });
          else {
            for (const x of a.entrees) {
              if (x.type === "group" && ecrit(x.droits)) groupes.push(x.nom ? { nom: x.nom, libelle: `groupe ${x.nom}` } : { gid: sp.gid, libelle: `groupe ${sp.gid}` });
              if (x.type === "user" && x.nom && ecrit(x.droits) && x.nom !== moi.nom && x.nom !== "root") {
                problemes.push({ niveau: "dangereux", code: "parent_acl", message: `${parent} : l'utilisateur ${x.nom} peut y écrire (ACL) et ${quoi}.` });
              }
            }
          }
          for (const g of groupes) evaluerGroupe(g);
        }
      }
    } else if (plateforme === "darwin") {
      if ((sp.mode & 0o030) === 0o030 && !protegeParSticky) evaluerGroupe({ gid: sp.gid, libelle: `groupe ${sp.gid}` });
      for (const [chemin, droitsDangereux, role] of [[parent, ["add_file", "add_subdirectory", "delete_child"], "parent"], ...(se && !estSensible ? [[cible, ["delete", "writesecurity", "chown"], "élément"]] : [])]) {
        const a = acl(chemin);
        if (!a.lisible) { problemes.push({ niveau: "incertain", code: "acl_incertaine", message: `${chemin} : ${a.raison}.` }); continue; }
        for (const x of a.entrees || []) {
          if (!x.autoriser || x.heritageSeul) continue;
          if (x.principal === "user" && (x.nom === moi.nom || x.nom === "root")) continue;
          if (x.droits.some((d) => droitsDangereux.includes(d))) problemes.push({ niveau: "dangereux", code: "parent_acl", message: `${chemin} (${role}) : ${x.principal} ${x.nom} a ${x.droits.join(", ")} (ACL).` });
        }
      }
    }
    function evaluerGroupe(g) {
      let gid = g.gid;
      if (gid === undefined) {
        try { gid = Number(execFileSync(outil("getent"), ["group", g.nom], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).split(":")[2]); } catch { gid = NaN; }
        if (!Number.isFinite(gid)) { problemes.push({ niveau: "incertain", code: "groupe_incertain", message: `${parent} : membres du ${g.libelle} inconnus.` }); return; }
      }
      const r = groupe(gid, moi);
      if (!r.certain) problemes.push({ niveau: "incertain", code: "groupe_incertain", message: `${parent} est modifiable par le ${g.libelle} et ses membres ne peuvent pas être établis avec certitude (${r.raison}).` });
      else if (r.autres.length) problemes.push({ niveau: "dangereux", code: "parent_modifiable_par_groupe", message: `${parent} est modifiable par le ${g.libelle}, qui contient d'autres comptes (${r.autres.slice(0, 5).join(", ")}${r.autres.length > 5 ? "…" : ""}) : ils peuvent ${quoi}.` });
    }
  }
  return problemes;
}

// Dossier sensible et son contenu (Linux, macOS).
export function analyserArbrePosix({ racine, vue, moi, plateforme, acl }) {
  const problemes = [];
  // inaccessiblesEtrangers : un élément inaccessible appartient à un autre compte (root compris).
  const res = { existe: false, aCorriger: [], problemes, inaccessibles: [], inaccessiblesEtrangers: false, exposition: [] };
  const s = vue.lstat(racine);
  if (!s) return res;
  res.existe = true;
  if (s.erreur) { problemes.push({ niveau: "incertain", code: "acces_inconnu", bloquant: true, message: `${racine} illisible (${s.erreur}).` }); res.inaccessibles.push(racine); return res; }
  if (s.lien) { problemes.push({ niveau: "incertain", code: "lien_symbolique", bloquant: true, message: `${racine} est un lien symbolique : aucune correction à travers lui.` }); return res; }
  if (!s.dossier) { problemes.push({ niveau: "incertain", code: "pas_un_dossier", bloquant: true, message: `${racine} n'est pas un dossier.` }); return res; }
  const pile = [{ chemin: racine, s }];
  while (pile.length) {
    const { chemin, s: st } = pile.pop();
    if (st.lien) { problemes.push({ niveau: "incertain", code: "lien_dans_le_dossier", bloquant: true, message: `${chemin} est un lien symbolique : non suivi.` }); continue; }
    if (!st.dossier && !st.fichier) { problemes.push({ niveau: "incertain", code: "type_inattendu", bloquant: true, message: `${chemin} n'est ni un fichier ni un dossier.` }); continue; }
    const trop = (st.mode & 0o077) !== 0;
    if (st.uid !== moi.uid) {
      if (st.uid !== 0) problemes.push({ niveau: "dangereux", code: "proprietaire_etranger", bloquant: true, message: `${chemin} appartient à un autre compte (uid ${st.uid}) : il peut en changer les permissions.` });
      if (trop) { problemes.push({ niveau: "dangereux", code: "droits_trop_larges", message: `${chemin} est accessible à d'autres comptes (droits ${octal(st.mode)}) et n'est pas à vous : correction impossible.` }); res.exposition.push(chemin); }
    } else if (trop) {
      res.aCorriger.push({ chemin, dossier: st.dossier, avant: st.mode, apres: st.mode & (st.dossier ? 0o700 : 0o600) });
      res.exposition.push(chemin);
    }
    const besoin = st.dossier ? fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK : fs.constants.R_OK;
    if (!vue.access(chemin, besoin)) { res.inaccessibles.push(chemin); if (st.uid !== moi.uid) res.inaccessiblesEtrangers = true; }
    if (plateforme === "darwin") {
      const a = acl(chemin);
      if (!a.lisible) problemes.push({ niveau: "incertain", code: "acl_incertaine", message: `${chemin} : ${a.raison}.` });
      for (const x of a.entrees || []) {
        if (!x.autoriser || x.heritageSeul || (x.principal === "user" && (x.nom === moi.nom || x.nom === "root"))) continue;
        problemes.push({ niveau: "dangereux", code: "acl_macos", message: `${chemin} : ${x.principal} ${x.nom} a ${x.droits.join(", ")} (ACL macOS, signalée mais non retirée).` });
      }
    }
    if (st.dossier && vue.access(chemin, fs.constants.R_OK | fs.constants.X_OK)) {
      let noms = [];
      try { noms = vue.readdir(chemin); } catch { res.inaccessibles.push(chemin); if (st.uid !== moi.uid) res.inaccessiblesEtrangers = true; }
      for (const n of noms) {
        const p = px.join(chemin, n);
        const sp = vue.lstat(p);
        if (sp && !sp.erreur) pile.push({ chemin: p, s: sp });
        else if (sp?.erreur) { res.inaccessibles.push(p); res.inaccessiblesEtrangers = true; }
      }
    }
  }
  if (res.inaccessibles.length) problemes.push({ niveau: "dangereux", code: "acces_refuse", acces: true, message: `Jurgenita ne peut pas lire ou modifier : ${res.inaccessibles.slice(0, 3).join(", ")}${res.inaccessibles.length > 3 ? "…" : ""}.` });
  return res;
}

// Resserrement d'un élément, sur le fichier déjà ouvert (sans suivre de lien),
// pour qu'un remplacement entre l'analyse et la correction ne puisse rien détourner.
export function resserrer({ chemin, dossier, avant, apres }, fsImpl = fs) {
  const c = fsImpl.constants;
  const drapeaux = c.O_RDONLY | (c.O_NOFOLLOW || 0) | (dossier && c.O_DIRECTORY ? c.O_DIRECTORY : 0);
  let fd;
  try {
    fd = fsImpl.openSync(chemin, drapeaux);
  } catch (err) {
    if (err.code !== "EACCES") throw err;
    // Vous n'avez pas le droit de lecture (ex. 200) : vérification puis chmod direct.
    const s = fsImpl.lstatSync(chemin);
    if (s.isSymbolicLink() || (s.mode & 0o7777) !== avant) throw Object.assign(new Error("élément modifié entre l'analyse et la correction"), { code: "EMODIFIE" });
    fsImpl.chmodSync(chemin, apres);
    return;
  }
  try {
    const s = fsImpl.fstatSync(fd);
    if ((s.mode & 0o7777) !== avant) throw Object.assign(new Error("élément modifié entre l'analyse et la correction"), { code: "EMODIFIE" });
    fsImpl.fchmodSync(fd, apres);
  } finally {
    fsImpl.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// .env : contrôle informatif uniquement (jamais modifié)
// ---------------------------------------------------------------------------
function controleEnvPosix(fichier, vue, moi, plateforme, acl) {
  const s = vue.lstat(fichier);
  if (!s || s.erreur) return null;
  const notes = [];
  if ((s.mode & 0o077) !== 0) notes.push(`lisible ou modifiable par d'autres comptes (droits ${octal(s.mode)})`);
  if (s.uid !== moi.uid && s.uid !== 0) notes.push(`appartient à un autre compte (uid ${s.uid})`);
  if (plateforme === "darwin") {
    const a = acl(fichier);
    if ((a.entrees || []).some((x) => x.autoriser && !(x.principal === "user" && (x.nom === moi.nom || x.nom === "root")))) notes.push("ACL macOS accordant des droits à d'autres comptes");
  }
  if (!notes.length) return { niveau: "sur", message: "Le fichier .env est réservé à votre compte." };
  return { niveau: "info", message: `Le fichier .env (clés principales) est ${notes.join(" et ")}.`, action: "Pour le réserver à votre compte : chmod 600 .env (non appliqué automatiquement)." };
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------
function nouveauRapport(mode, plateforme) {
  return {
    mode, plateforme, niveau: "sur", acces: "ok", etat: "protege", resume: "",
    problemes: [], corrections: [], fonctionnalites: [], actions: [], sauvegarde: null, env: null,
    verifie_le: new Date().toISOString(),
  };
}

function ajouter(rapport, problemes, prefixe = "") {
  for (const p of problemes) {
    if (rapport.problemes.some((x) => x.code === p.code && x.message === p.message)) continue;
    rapport.problemes.push({ niveau: p.niveau, code: p.code, message: prefixe + p.message, ...(p.vous !== undefined && { vous: p.vous }) });
    rapport.niveau = pire(rapport.niveau, p.niveau === "info" ? "sur" : p.niveau);
    if (p.acces) rapport.acces = "refuse";
  }
}

const FONCTIONS_MARQUES = "accès des marques (Instagram et Facebook, Meta Ads, avis Google, TikTok, LinkedIn, lien de validation client)";
const FONCTIONS_GOOGLE = "connexion Google (Gmail, Agenda, avis Google)";

function finaliser(rapport) {
  const codes = new Set(rapport.problemes.map((p) => p.code));
  if (rapport.acces === "refuse") rapport.fonctionnalites.push(`Indisponibles tant que l'accès est refusé : ${FONCTIONS_MARQUES} et ${FONCTIONS_GOOGLE} ; l'enregistrement des accès est refusé.`);
  if ([...codes].some((c) => ["droits_trop_larges", "acces_autres_comptes", "acl_macos", "proprietaire_etranger"].includes(c)) || (rapport.etat === "verification_seule" && rapport.niveau === "dangereux")) {
    rapport.fonctionnalites.push(`Aucune panne, mais d'autres comptes de cet ordinateur peuvent lire ou modifier vos jetons : ${FONCTIONS_MARQUES} et ${FONCTIONS_GOOGLE}.`);
  }
  if ([...codes].some((c) => c.startsWith("parent_") || c === "chaine_sans_acl")) {
    rapport.fonctionnalites.push("Un autre compte pourrait remplacer le dossier des secrets : Jurgenita lirait ou écrirait alors vos accès dans un dossier qu'il a préparé.");
  }
  const etats = {
    protege: "Dossier des secrets protégé.",
    corrige: "Droits du dossier des secrets resserrés au démarrage.",
    verification_seule: "Mode vérification : rien n'a été modifié.",
    correction_interrompue: "Correction automatique interrompue par prudence.",
    non_verifiable: "Protection impossible à vérifier sur ce système.",
    restauration_partielle: "Correction échouée : restauration partielle (dossier principal resté protégé).",
    critique: "Correction échouée et restauration incomplète : intervention nécessaire.",
    absent: "Aucun accès enregistré pour l'instant.",
  };
  rapport.resume = `${etats[rapport.etat] || ""}${rapport.niveau === "dangereux" ? " Protection insuffisante." : rapport.niveau === "incertain" ? " Situation incertaine." : ""}`.trim();
  return rapport;
}

// Version publique (API, interface) : aucun secret, jamais de contenu de fichier.
export function rapportPublic(r) {
  if (!r) return null;
  const { mode, plateforme, niveau, acces, etat, resume, problemes, corrections, fonctionnalites, actions, sauvegarde, env, verifie_le } = r;
  return { mode, plateforme, niveau, acces, etat, resume, problemes, corrections, fonctionnalites, actions, sauvegarde, env, verifie_le };
}

// ---------------------------------------------------------------------------
// Vérification et correction
// ---------------------------------------------------------------------------
let dernier = null;
let enCours = null;

export const dernierRapport = () => dernier;

export function ensureSecretsDir(options = {}) {
  if (enCours) return enCours;
  enCours = proteger(options)
    .catch((err) => {
      const r = nouveauRapport(modeProtection().mode, process.platform);
      r.etat = "non_verifiable";
      ajouter(r, [{ niveau: "incertain", code: "erreur_interne", message: `Vérification interrompue (${err?.code || err?.name || "erreur"}).` }]);
      return finaliser(r);
    })
    .then((r) => { dernier = r; return r; })
    .finally(() => { enCours = null; });
  return enCours;
}

// Avant d'écrire un secret : si le dossier a disparu, il est recréé protégé.
export async function avantEcriture() {
  if (!fs.existsSync(secretsRoot())) await ensureSecretsDir();
}

function verifierConfiguration(racine, sauvegardes, realpath) {
  const dedans = (a, b) => { const r = path.relative(a, b); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  if (dedans(racine, sauvegardes) || dedans(sauvegardes, racine)) return false;
  const ra = realpath(racine);
  const rb = realpath(sauvegardes);
  if (ra && rb && (dedans(ra, rb) || dedans(rb, ra))) return false;
  return true;
}

async function proteger({ plateforme = process.platform, fsImpl = fs, ...opts } = {}) {
  const { mode, inconnu } = modeProtection();
  const r = nouveauRapport(mode, plateforme);
  if (inconnu) ajouter(r, [{ niveau: "info", code: "mode_inconnu", message: `Valeur inconnue de JURGENITA_SECRETS_PERMISSIONS (« ${inconnu} ») : mode vérification appliqué.` }]);
  const racine = secretsRoot();
  const sauvegardes = backupsDir();
  if (!verifierConfiguration(racine, sauvegardes, (p) => { try { return fsImpl.realpathSync(p); } catch { return null; } })) {
    r.etat = "correction_interrompue";
    ajouter(r, [{ niveau: "incertain", code: "configuration", message: "Le dossier des sauvegardes de droits et le dossier des secrets ne doivent pas être l'un dans l'autre." }]);
    return finaliser(r);
  }
  if (plateforme === "win32") return finaliser(await protegerWindows(r, { racine, sauvegardes, mode, fsImpl, ...opts }));
  return finaliser(await protegerPosix(r, { racine, sauvegardes, mode, plateforme, fsImpl, ...opts }));
}

async function protegerPosix(r, { racine, sauvegardes, mode, plateforme, fsImpl, vue = vuePosix(fsImpl), moi = moiPosix(), groupe, acl, env = envFile() }) {
  groupe = groupe || (plateforme === "darwin" ? groupesMac() : groupesLinux());
  acl = acl || (plateforme === "darwin" ? aclMac() : aclLinux());
  const chaines = {
    secrets: analyserChainePosix({ sensible: racine, vue, moi, groupe, acl, plateforme }),
    sauvegardes: analyserChainePosix({ sensible: sauvegardes, vue, moi, groupe, acl, plateforme }),
  };
  ajouter(r, chaines.secrets, "Chaîne du dossier des secrets : ");
  ajouter(r, chaines.sauvegardes.filter((p) => !chaines.secrets.some((q) => q.message === p.message)), "Chaîne du dossier des sauvegardes : ");
  const chaineSure = !chaines.secrets.length && !chaines.sauvegardes.length;
  let arbre = analyserArbrePosix({ racine, vue, moi, plateforme, acl });
  ajouter(r, arbre.problemes);
  r.env = controleEnvPosix(env, vue, moi, plateforme, acl);
  const bloquant = arbre.problemes.some((p) => p.bloquant);
  const expose = arbre.aCorriger.length > 0;

  if (mode === "verifier") {
    r.etat = "verification_seule";
    if (expose) ajouter(r, arbre.aCorriger.map((c) => ({ niveau: "dangereux", code: "droits_trop_larges", message: `${afficher(c.chemin)} est accessible à d'autres comptes (droits ${octal(c.avant)}) ; correction possible : ${octal(c.apres)}.` })));
    if (expose) r.actions.push("Relancez Jurgenita sans JURGENITA_SECRETS_PERMISSIONS=verifier pour resserrer automatiquement ces droits.");
    return conseilsPosix(r, chaines, moi, arbre);
  }
  if (!chaineSure || bloquant) {
    r.etat = "correction_interrompue";
    if (expose) ajouter(r, arbre.aCorriger.map((c) => ({ niveau: "dangereux", code: "droits_trop_larges", message: `${afficher(c.chemin)} reste accessible à d'autres comptes (droits ${octal(c.avant)}).` })));
    return conseilsPosix(r, chaines, moi, arbre);
  }
  // Création du dossier des secrets, directement protégé.
  if (!arbre.existe) {
    try {
      fsImpl.mkdirSync(racine, { recursive: true, mode: 0o700 });
    } catch (err) {
      r.etat = "correction_interrompue";
      ajouter(r, [{ niveau: "dangereux", code: err.code === "EACCES" ? "acces_refuse" : "creation_impossible", acces: err.code === "EACCES", message: `Création de ${afficher(racine)} impossible (${err.code}).` }]);
      return conseilsPosix(r, chaines, moi, arbre);
    }
    arbre = analyserArbrePosix({ racine, vue, moi, plateforme, acl });
    ajouter(r, arbre.problemes);
    if (arbre.problemes.some((p) => p.bloquant) || arbre.aCorriger.length) {
      r.etat = "correction_interrompue";
      return conseilsPosix(r, chaines, moi, arbre);
    }
  }
  if (!arbre.aCorriger.length) {
    r.etat = r.acces === "refuse" ? "correction_interrompue" : "protege";
    return conseilsPosix(r, chaines, moi, arbre);
  }
  // 1. Dossier des sauvegardes : créé ou resserré (lui aussi, uniquement par resserrement).
  const sv = await preparerSauvegardesPosix({ sauvegardes, vue, moi, plateforme, acl, fsImpl });
  if (!sv.ok) {
    r.etat = "correction_interrompue";
    ajouter(r, sv.problemes);
    ajouter(r, arbre.aCorriger.map((c) => ({ niveau: "dangereux", code: "droits_trop_larges", message: `${afficher(c.chemin)} reste accessible à d'autres comptes (droits ${octal(c.avant)}).` })));
    return conseilsPosix(r, chaines, moi, arbre);
  }
  r.corrections.push(...sv.corrections);
  // 2. Sauvegarde des droits actuels, avant toute modification.
  const fichier = path.join(sauvegardes, `droits-${horodatage()}-${randomBytes(3).toString("hex")}.json`);
  try {
    await writeJsonAtomicAsync(fichier, {
      version: 1, plateforme, cree: new Date().toISOString(), racine,
      elements: arbre.aCorriger.map((c) => ({ chemin: relatif(racine, c.chemin), type: c.dossier ? "dossier" : "fichier", mode: octal(c.avant) })),
      dossier_sauvegardes: sv.corrections,
      restauration: `node scripts/restaurer-droits-secrets.mjs ${afficher(fichier)} --appliquer`,
    }, { mode: 0o600, dirMode: 0o700 });
  } catch (err) {
    r.etat = "correction_interrompue";
    ajouter(r, [{ niveau: "incertain", code: "sauvegarde_impossible", message: `Sauvegarde des droits impossible (${err.code || err.name}) : rien n'a été modifié.` }]);
    return conseilsPosix(r, chaines, moi, arbre);
  }
  r.sauvegarde = afficher(fichier);
  // 3. Resserrement. Pas de retour automatique vers des droits plus larges :
  //    une correction partielle laisse les éléments déjà resserrés protégés.
  const faits = [];
  for (const c of arbre.aCorriger) {
    try {
      resserrer(c, fsImpl);
      faits.push(c);
    } catch (err) {
      r.etat = "correction_interrompue";
      ajouter(r, [{ niveau: "dangereux", code: "correction_partielle", message: `Resserrement de ${afficher(c.chemin)} impossible (${err.code || err.name}). Les éléments déjà resserrés restent protégés ; la sauvegarde permet un retour arrière manuel.` }]);
      break;
    }
  }
  // 4. Vérification.
  for (const c of faits) {
    const s = vue.lstat(c.chemin);
    if (!s || (s.mode & 0o077) !== 0) {
      ajouter(r, [{ niveau: "dangereux", code: "chmod_sans_effet", message: `${afficher(c.chemin)} : le resserrement est resté sans effet (système de fichiers sans droits POSIX, par exemple WSL sur /mnt/c, exFAT ou partage réseau).` }]);
    } else {
      r.corrections.push(`${afficher(c.chemin)} : ${octal(c.avant)} → ${octal(s.mode)}`);
    }
  }
  if (r.etat !== "correction_interrompue") r.etat = r.problemes.some((p) => p.code === "chmod_sans_effet") ? "correction_interrompue" : "corrige";
  return conseilsPosix(r, chaines, moi, arbre);
}

async function preparerSauvegardesPosix({ sauvegardes, vue, moi, plateforme, acl, fsImpl }) {
  const corrections = [];
  if (!vue.lstat(sauvegardes)) {
    try { fsImpl.mkdirSync(sauvegardes, { recursive: true, mode: 0o700 }); } catch (err) {
      return { ok: false, problemes: [{ niveau: "incertain", code: "sauvegarde_impossible", message: `Création du dossier des sauvegardes impossible (${err.code}) : rien n'a été modifié.` }] };
    }
  }
  const a = analyserArbrePosix({ racine: sauvegardes, vue, moi, plateforme, acl });
  if (a.problemes.length) return { ok: false, problemes: a.problemes.map((p) => ({ ...p, message: `Dossier des sauvegardes : ${p.message}` })) };
  for (const c of a.aCorriger) {
    try { resserrer(c, fsImpl); corrections.push(`${afficher(c.chemin)} : ${octal(c.avant)} → ${octal(c.apres)}`); } catch (err) {
      return { ok: false, problemes: [{ niveau: "incertain", code: "sauvegarde_impossible", message: `Dossier des sauvegardes non protégeable (${err.code || err.name}) : rien n'a été modifié.` }] };
    }
  }
  return { ok: true, corrections };
}

function conseilsPosix(r, chaines, moi, arbre) {
  const codes = new Set(r.problemes.map((p) => p.code));
  const racine = afficher(secretsRoot());
  if (codes.has("proprietaire_etranger") || arbre?.inaccessiblesEtrangers) r.actions.push(`Rendez-vous propriétaire du dossier des secrets : sudo chown -R ${moi.nom} ${racine} (commande à lancer vous-même).`);
  else if (codes.has("acces_refuse") && arbre?.existe) r.actions.push(`Rendez à votre compte ses propres droits sur le dossier des secrets : chmod -R u+rwX ${racine} (commande à lancer vous-même ; elle ne donne aucun droit aux autres comptes).`);
  else if (codes.has("acces_refuse")) r.actions.push(`Votre compte ne peut pas créer ${racine} : vérifiez les droits du dossier qui doit le contenir (ls -ld ${afficher(path.dirname(secretsRoot()))}), sans les élargir aux autres comptes.`);
  if ([...codes].some((c) => c.startsWith("parent_"))) r.actions.push("Placez le dossier jurgenita dans votre dossier personnel, ou retirez aux autres comptes le droit d'écrire dans les dossiers parents signalés (par exemple chmod o-w,g-w <dossier>) : Jurgenita ne modifie jamais les dossiers parents.");
  if (codes.has("groupe_incertain") || codes.has("acl_incertaine")) r.actions.push("Vérifiez qui peut écrire dans les dossiers parents signalés (ls -ld, getfacl), puis relancez Jurgenita.");
  if (r.env?.action) r.actions.push(r.env.action);
  return r;
}

const horodatage = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const relatif = (racine, p) => { const x = path.relative(racine, p); return x ? x.split(path.sep).join("/") : "."; };

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
async function protegerWindows(r, { racine, sauvegardes, mode, fsImpl, ps = win.executerPowerShell, whoami = win.executerWhoami, env = envFile() }) {
  const chemins = [...new Set([...win.ancetres(racine), ...win.ancetres(sauvegardes), env])];
  const [lu, wu, wg] = await Promise.all([win.inspecter(ps, { arbres: [racine, sauvegardes], chemins }), whoami(["/user", "/fo", "csv", "/nh"]), whoami(["/groups", "/fo", "csv", "/nh"])]);
  if (!lu.ok) {
    r.etat = "non_verifiable";
    const raison = lu.code === "langage_restreint" ? "PowerShell est restreint par la politique de sécurité de l'ordinateur" : `PowerShell indisponible (${lu.code})`;
    ajouter(r, [{ niveau: "incertain", code: "non_verifiable", message: `${raison} : protection non vérifiable, rien n'a été modifié.` }]);
    return r;
  }
  const jeton = win.construireJeton(lu.jeton, wu, wg);
  const noms = lu.noms;
  const [arbreSecrets, arbreSauvegardes] = lu.arbres;
  const elementsChaine = [...lu.chemins, ...arbreSecrets.elements, ...arbreSauvegardes.elements];
  // .env : contrôle informatif.
  const e = lu.chemins.find((x) => x.chemin.toLowerCase() === env.toLowerCase());
  if (e?.existe && e.securite) {
    const lecteurs = (e.securite.nulle ? [{ sid: win.SID.TOUT_LE_MONDE }] : (e.securite.entrees || []).filter((x) => x.type === 0 && !(x.drapeaux & 0x08) && ![jeton.utilisateur, win.SID.SYSTEME, win.SID.ADMINISTRATEURS].includes(x.sid) && (win.droitsReels(x.masque) & win.DROIT.LECTURE_DONNEES)));
    r.env = lecteurs.length
      ? { niveau: "info", message: `Le fichier .env (clés principales) est lisible par : ${lecteurs.map((x) => win.nomCompte(x.sid, noms)).join(", ")}.`, action: `Pour le réserver à votre compte : icacls .env /inheritance:r /grant:r *${jeton.utilisateur}:F *${win.SID.SYSTEME}:F *${win.SID.ADMINISTRATEURS}:F (non appliqué automatiquement).` }
      : { niveau: "sur", message: "Le fichier .env est réservé à votre compte, SYSTEM et Administrateurs." };
  }
  if (!jeton.certain) ajouter(r, [{ niveau: "incertain", code: "jeton_incertain", message: `Jeton de sécurité incertain (${jeton.problemes.join(" ; ")}).` }]);
  for (const a of [arbreSecrets, arbreSauvegardes]) {
    const v = a.volume || {};
    if (v.erreur || !["NTFS", "ReFS"].includes(v.format) || !["Fixed", "Removable"].includes(v.type)) {
      ajouter(r, [{ niveau: "incertain", code: "volume_non_verifiable", message: `${afficher(a.racine)} : disque ${v.type || "inconnu"} ${v.format || ""} (réseau, FAT, exFAT ou inconnu) : autorisations NTFS non vérifiables.` }]);
    }
  }
  const chaineSecrets = win.analyserChaine({ sensible: racine, elements: elementsChaine, jeton, noms });
  const chaineSauvegardes = win.analyserChaine({ sensible: sauvegardes, elements: elementsChaine, jeton, noms });
  ajouter(r, chaineSecrets, "Chaîne du dossier des secrets : ");
  ajouter(r, chaineSauvegardes.filter((p) => !chaineSecrets.some((q) => q.message === p.message)), "Chaîne du dossier des sauvegardes : ");
  const analyseSecrets = win.analyserArbre({ racine, elements: arbreSecrets.elements, jeton, noms });
  const analyseSauvegardes = win.analyserArbre({ racine: sauvegardes, elements: arbreSauvegardes.elements, jeton, noms });
  ajouter(r, analyseSecrets.problemes);
  ajouter(r, analyseSauvegardes.problemes, "Dossier des sauvegardes : ");
  const exposition = (a) => a.exposition.map((x) => ({ niveau: "dangereux", code: "acces_autres_comptes", message: `${afficher(x.chemin)} est accessible à ${win.nomCompte(x.sid, noms)}.` }));
  // Accès réel de Jurgenita (Node lui-même) au dossier des secrets.
  const refus = win.verifierAccesReel(arbreSecrets.elements, { fsImpl, sonde: false });
  if (refus.length) ajouter(r, [{ niveau: "dangereux", code: "acces_refuse", acces: true, message: `Jurgenita ne peut pas lire : ${refus.slice(0, 3).map((x) => afficher(x.chemin)).join(", ")}.` }]);
  const bloquant = !jeton.certain || r.problemes.some((p) => p.code === "volume_non_verifiable") || chaineSecrets.length > 0 || chaineSauvegardes.length > 0 || analyseSecrets.bloquant || analyseSauvegardes.bloquant;
  const conseils = () => conseilsWindows(r, jeton);

  if (mode === "verifier") {
    r.etat = "verification_seule";
    ajouter(r, exposition(analyseSecrets));
    if (analyseSecrets.existe && !analyseSecrets.conforme && !bloquant) r.actions.push("Relancez Jurgenita sans JURGENITA_SECRETS_PERMISSIONS=verifier pour appliquer la protection.");
    return conseils();
  }
  if (bloquant) {
    r.etat = "correction_interrompue";
    ajouter(r, exposition(analyseSecrets));
    return conseils();
  }
  // 1. Dossier des sauvegardes : créé puis protégé (restauration en mémoire si échec).
  let elementsSauvegardes = arbreSauvegardes.elements;
  if (!analyseSauvegardes.existe || !analyseSauvegardes.conforme) {
    if (!analyseSauvegardes.existe) {
      try { fsImpl.mkdirSync(sauvegardes, { recursive: true }); } catch (err) {
        r.etat = "correction_interrompue";
        ajouter(r, [{ niveau: "incertain", code: "sauvegarde_impossible", message: `Création du dossier des sauvegardes impossible (${err.code}) : rien n'a été modifié.` }]);
        return conseils();
      }
      const relu = await win.inspecter(ps, { arbres: [sauvegardes] });
      if (!relu.ok) { r.etat = "correction_interrompue"; ajouter(r, [{ niveau: "incertain", code: "sauvegarde_impossible", message: "Dossier des sauvegardes illisible après création : rien n'a été modifié." }]); return conseils(); }
      elementsSauvegardes = relu.arbres[0].elements;
      const a2 = win.analyserArbre({ racine: sauvegardes, elements: elementsSauvegardes, jeton, noms });
      if (a2.bloquant) { r.etat = "correction_interrompue"; ajouter(r, a2.problemes, "Dossier des sauvegardes : "); return conseils(); }
    }
    const p = await win.protegerArbre({ racine: sauvegardes, elements: elementsSauvegardes, jeton, ps, fsImpl });
    if (!p.ok) {
      r.etat = p.restauration?.ok === false ? p.restauration.etat : "correction_interrompue";
      ajouter(r, [{ niveau: p.restauration?.ok === false ? "dangereux" : "incertain", code: "sauvegarde_impossible", message: `Protection du dossier des sauvegardes échouée (${p.etape} : ${p.detail}) ; ${p.restauration?.ok ? "état d'origine restauré" : "restauration incomplète"} ; rien d'autre n'a été modifié.` }]);
      return conseils();
    }
    r.corrections.push(`${afficher(sauvegardes)} : protégé (vous, SYSTEM, Administrateurs)`);
  }
  // 2. Dossier des secrets : créé si besoin.
  let elementsSecrets = arbreSecrets.elements;
  if (!analyseSecrets.existe) {
    try { fsImpl.mkdirSync(racine, { recursive: true }); } catch (err) {
      r.etat = "correction_interrompue";
      ajouter(r, [{ niveau: "dangereux", code: "creation_impossible", message: `Création de ${afficher(racine)} impossible (${err.code}).` }]);
      return conseils();
    }
    const relu = await win.inspecter(ps, { arbres: [racine] });
    if (!relu.ok) { r.etat = "correction_interrompue"; ajouter(r, [{ niveau: "incertain", code: "non_verifiable", message: "Dossier des secrets illisible après création." }]); return conseils(); }
    elementsSecrets = relu.arbres[0].elements;
  }
  const a = win.analyserArbre({ racine, elements: elementsSecrets, jeton, noms });
  if (a.bloquant) { r.etat = "correction_interrompue"; ajouter(r, a.problemes); return conseils(); }
  if (a.conforme) { r.etat = r.corrections.length ? "corrige" : "protege"; return conseils(); }
  // 3. Sauvegarde puis protection du dossier des secrets.
  const fichier = win.wpathJoin(sauvegardes, `acl-${horodatage()}-${randomBytes(3).toString("hex")}.json`);
  const sauvegarder = async (instantane) => {
    await writeJsonAtomicAsync(fichier, {
      version: 1, plateforme: "win32", cree: new Date().toISOString(), racine, utilisateur: jeton.utilisateur,
      elements: instantane.map((x) => ({ chemin: win.relatifWin(racine, x.chemin), type: x.dossier ? "dossier" : "fichier", sddl: x.securite.sddl, securite: x.securite })),
      restauration: `node scripts/restaurer-droits-secrets.mjs ${afficher(fichier)} --appliquer`,
    }, { mode: 0o600 });
    r.sauvegarde = afficher(fichier);
  };
  const p = await win.protegerArbre({ racine, elements: elementsSecrets, jeton, ps, fsImpl, sauvegarder });
  if (p.ok) {
    r.etat = "corrige";
    r.corrections.push(`${afficher(racine)} : héritage coupé ; contrôle total pour vous, SYSTEM et Administrateurs uniquement (${p.corrections} opération(s))`);
    return conseils();
  }
  if (p.etape === "sauvegarde") {
    r.etat = "correction_interrompue";
    ajouter(r, [{ niveau: "incertain", code: "sauvegarde_impossible", message: "Sauvegarde des autorisations impossible : rien n'a été modifié." }]);
    ajouter(r, exposition(analyseSecrets));
    return conseils();
  }
  if (p.restauration?.ok) {
    r.etat = "correction_interrompue";
    ajouter(r, [{ niveau: "incertain", code: "correction_annulee", message: `Protection échouée (${p.etape} : ${p.detail}) : autorisations d'origine restaurées et vérifiées.` }]);
    ajouter(r, exposition(analyseSecrets));
  } else {
    r.etat = p.restauration?.etat || "critique";
    ajouter(r, [{ niveau: "dangereux", code: r.etat, message: `Protection échouée (${p.etape} : ${p.detail}) puis restauration ${r.etat === "restauration_partielle" ? "partielle : le dossier principal est resté protégé et vous gardez l'accès" : "incomplète"}. Sauvegarde : ${r.sauvegarde || "aucune"}.` }]);
    r.actions.push(`Restaurez manuellement : node scripts/restaurer-droits-secrets.mjs ${r.sauvegarde || "<sauvegarde>"} (aperçu), puis avec --appliquer.`);
  }
  return conseils();
}

function conseilsWindows(r, jeton) {
  const codes = new Set(r.problemes.map((p) => p.code));
  if ([...codes].some((c) => c.startsWith("parent_") || c === "chaine_sans_acl")) {
    r.actions.push("Clonez à nouveau le projet dans votre profil (C:\\Users\\<nom>\\…) : un simple déplacement sur le même disque conserve les anciennes autorisations. Sinon, faites retirer par un administrateur les droits signalés sur les dossiers parents. Jurgenita ne modifie jamais les dossiers parents.");
  }
  if (codes.has("regle_de_refus")) r.actions.push("Une règle de refus est présente : examinez-la (icacls <dossier>) et retirez-la si elle n'est pas voulue, puis relancez Jurgenita.");
  if (codes.has("jeton_incertain") || codes.has("chaine_illisible") || codes.has("chaine_lien") || codes.has("lien_ou_jonction")) r.actions.push("Situation incertaine : vérifiez les autorisations avec icacls, puis relancez Jurgenita.");
  if (r.env?.action) r.actions.push(r.env.action);
  return r;
}

// Diagnostic d'un refus d'écriture en fin de reprise (Windows) : refus
// permanent ou verrou passager ? Ailleurs, EACCES est déjà sans ambiguïté.
export async function diagnostiquerAcces(fichier, opts = {}) {
  if ((opts.plateforme || process.platform) !== "win32") return "incertain";
  try { return await win.diagnostiquerAcces(fichier, opts); } catch { return "incertain"; }
}

// Lignes du journal de démarrage (aucun secret).
export function lignesJournal(rapport) {
  if (!rapport) return [];
  const symbole = rapport.niveau === "sur" ? "🔒" : "⚠";
  const lignes = [`  ${symbole} Protection des secrets : ${rapport.resume}`];
  for (const c of rapport.corrections.slice(0, 5)) lignes.push(`      corrigé : ${c}`);
  for (const p of rapport.problemes.slice(0, 6)) lignes.push(`      [${p.niveau}] ${p.message}`);
  if (rapport.sauvegarde) lignes.push(`      sauvegarde des droits : ${rapport.sauvegarde}`);
  for (const f of rapport.fonctionnalites) lignes.push(`      ${f}`);
  for (const a of rapport.actions.slice(0, 3)) lignes.push(`      → ${a}`);
  if (rapport.env && rapport.env.niveau !== "sur") lignes.push(`      ℹ ${rapport.env.message}`);
  return lignes;
}
