// Restauration manuelle des droits du dossier des secrets depuis une
// sauvegarde (sous-étape 2b.4). Par défaut : APERÇU, rien n'est modifié.
//
//   node scripts/restaurer-droits-secrets.mjs <sauvegarde.json>              aperçu
//   node scripts/restaurer-droits-secrets.mjs <sauvegarde.json> --appliquer  restauration
//
// Garde-fous, tous vérifiés avant d'appliquer quoi que ce soit :
// - contenu : version, système, dossier des secrets, chemins (jamais hors du
//   dossier des secrets), types et droits valides ; sous Windows, les
//   autorisations à appliquer (SDDL), relues par Windows, doivent décrire
//   exactement l'état enregistré à côté ;
// - protection : la sauvegarde se trouve dans le dossier des sauvegardes, qui
//   est protégé ; le fichier de sauvegarde lui-même n'appartient qu'à vous (ou
//   à SYSTEM, Administrateurs) et n'a que les autorisations attendues ; la
//   chaîne des dossiers parents est sûre ;
// - état actuel : chaque élément à restaurer a gardé son type, n'est pas
//   devenu un lien et vous appartient (Linux, macOS).
// Une sauvegarde altérée est refusée. Ordre : éléments contenus d'abord (du
// plus profond au moins profond), vérification, dossier principal en dernier,
// vérification finale (droits effectifs compris). Les dossiers parents ne sont
// jamais modifiés.
// Codes de sortie : 0 aperçu ou restauration vérifiée, 1 échec, 2 usage,
// 3 sauvegarde altérée, invalide ou d'un autre dossier, 4 refus par prudence,
// 5 PowerShell indisponible.
import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "../src/atomic-file.js";
import * as sd from "../src/secret-dir.js";
import * as win from "../src/secret-dir-windows.js";

const args = process.argv.slice(2);
const appliquer = args.includes("--appliquer");
const fichierArg = args.find((a) => !a.startsWith("--"));
const sortir = (code, ...lignes) => { for (const l of lignes) (code ? console.error : console.log)(l); process.exit(code); };
if (!fichierArg) sortir(2, "Usage : node scripts/restaurer-droits-secrets.mjs <sauvegarde.json> [--appliquer]");

const windows = process.platform === "win32";
const fichier = path.resolve(fichierArg);
const lu = readJsonFile(fichier);
if (lu.etat !== "ok") sortir(3, `Sauvegarde illisible : ${fichierArg} (${lu.etat}).`);
const sauvegarde = lu.valeur;
const racine = sd.secretsRoot();
const sauvegardes = sd.backupsDir();
const egaux = (a, b) => (windows ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const reel = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

if (sauvegarde?.version !== 1 || sauvegarde?.plateforme !== process.platform) sortir(3, "Cette sauvegarde ne correspond pas à ce système.");
if (!egaux(sauvegarde.racine, racine)) sortir(3, `Cette sauvegarde concerne ${sauvegarde.racine}, pas le dossier des secrets actuel (${racine}).`);
if (!egaux(reel(path.dirname(fichier)), reel(sauvegardes))) sortir(3, `La sauvegarde doit se trouver dans ${sauvegardes}.`);

// 1. Contenu de la sauvegarde.
const valide = sd.validerSauvegarde(sauvegarde, { racine });
if (!valide.ok) sortir(3, "Sauvegarde altérée ou invalide : rien n'a été modifié.", ...valide.erreurs.map((e) => `  - ${e}`));
const elements = valide.elements;
const presents = elements.filter((e) => lstat(e.absolu));
const absents = elements.filter((e) => !presents.includes(e));
const profondeur = (rel) => (rel === "." ? 0 : rel.split("/").length);

// 2. Protection de la sauvegarde (dossier et fichier), chaîne des parents ;
//    sous Windows, cohérence des autorisations enregistrées.
async function garde() {
  const refus = [];
  const alterations = [];
  let jeton = null;
  if (windows) {
    const ps = win.executerPowerShell;
    const luSv = await win.inspecter(ps, { arbres: [sauvegardes], chemins: win.ancetres(sauvegardes) });
    if (!luSv.ok) sortir(5, `PowerShell indisponible (${luSv.code}) : rien n'a été modifié.`);
    jeton = win.construireJeton(luSv.jeton, await win.executerWhoami(["/user", "/fo", "csv", "/nh"]), await win.executerWhoami(["/groups", "/fo", "csv", "/nh"]));
    if (!jeton.certain) refus.push(`Jeton incertain (${jeton.problemes.join(" ; ")}).`);
    const elementsSv = luSv.arbres[0].elements;
    const a = win.analyserArbre({ racine: sauvegardes, elements: elementsSv, jeton, noms: luSv.noms });
    if (!a.conforme) refus.push("Le dossier des sauvegardes n'est pas protégé (vous, SYSTEM, Administrateurs uniquement) : un autre compte a pu modifier la sauvegarde.");
    const f = elementsSv.find((x) => egaux(x.chemin, fichier));
    if (!f?.securite) refus.push("Autorisations du fichier de sauvegarde illisibles.");
    else {
      if (!win.proprietaireAutorise(f.securite, jeton)) refus.push(`Sauvegarde altérée : le fichier appartient à ${win.nomCompte(f.securite.proprietaire, luSv.noms)}, pas à vous, SYSTEM ou Administrateurs.`);
      if (!win.enfantConforme(f.securite, jeton)) refus.push("Sauvegarde altérée : les autorisations du fichier ne sont plus celles attendues (vous, SYSTEM et Administrateurs, par héritage du dossier des sauvegardes).");
    }
    refus.push(...a.problemes.map((p) => p.message));
    refus.push(...win.analyserChaine({ sensible: sauvegardes, elements: [...luSv.chemins, ...elementsSv], jeton, noms: luSv.noms }).map((p) => p.message));
    const conv = await win.convertirSddl(ps, elements.map((e) => e.sddl));
    if (!conv.ok) sortir(5, `PowerShell indisponible (${conv.code}) : rien n'a été modifié.`);
    elements.forEach((e, i) => {
      const r = conv.resultats[i];
      if (!r.ok || !win.memesDroits(r.securite, e.securite, { herites: true, proprietaire: true })) alterations.push(`${e.chemin} : les autorisations à appliquer ne correspondent pas à l'état enregistré.`);
    });
  } else {
    const vue = sd.vuePosix();
    const moi = sd.moiPosix();
    const plateforme = process.platform;
    const groupe = plateforme === "darwin" ? sd.groupesMac() : sd.groupesLinux();
    const acl = plateforme === "darwin" ? sd.aclMac() : sd.aclLinux();
    const a = sd.analyserArbrePosix({ racine: sauvegardes, vue, moi, plateforme, acl });
    if (a.aCorriger.length) refus.push(`Le dossier des sauvegardes est accessible à d'autres comptes (${a.aCorriger.map((c) => c.chemin).join(", ")}) : un autre compte a pu modifier la sauvegarde.`);
    const st = lstat(fichier);
    if (!st || st.isSymbolicLink() || !st.isFile()) refus.push("Sauvegarde altérée : ce n'est pas un fichier ordinaire.");
    else {
      if (st.uid !== moi.uid && st.uid !== 0) refus.push(`Sauvegarde altérée : le fichier appartient à un autre compte (uid ${st.uid}).`);
      if ((st.mode & 0o077) !== 0) refus.push(`Sauvegarde altérée : le fichier est accessible à d'autres comptes (droits ${(st.mode & 0o777).toString(8)}).`);
    }
    refus.push(...a.problemes.map((p) => p.message));
    refus.push(...sd.analyserChainePosix({ sensible: sauvegardes, vue, moi, groupe, acl, plateforme }).map((p) => p.message));
  }
  // État actuel des éléments à restaurer.
  for (const e of presents) {
    const st = lstat(e.absolu);
    if (st.isSymbolicLink()) refus.push(`${e.chemin} est devenu un lien : restauration refusée.`);
    else if (st.isDirectory() !== (e.type === "dossier")) refus.push(`${e.chemin} n'est plus un ${e.type} : restauration refusée.`);
    else if (!windows && st.uid !== process.getuid() && process.getuid() !== 0) refus.push(`${e.chemin} appartient à un autre compte (uid ${st.uid}) : ses droits ne peuvent pas être rétablis.`);
  }
  return { refus, alterations, jeton };
}

// 3. Aperçu.
function decrire(e) {
  if (!windows) return `${e.chemin} → droits ${e.mode}`;
  const s = e.securite || {};
  const explicites = (s.entrees || []).filter((x) => !(x.drapeaux & 0x10)).length;
  return `${e.chemin} → ${s.protegee ? "héritage coupé" : "héritage actif"}, ${explicites} autorisation(s) explicite(s), propriétaire ${s.proprietaire}`;
}

const { refus, alterations, jeton } = await garde();
console.log(`Sauvegarde : ${fichier}`);
console.log(`Dossier des secrets : ${racine}`);
console.log("Ordre de restauration : éléments contenus (du plus profond au moins profond), puis le dossier principal.");
for (const e of [...presents].sort((a, b) => profondeur(b.chemin) - profondeur(a.chemin))) console.log(`  • ${decrire(e)}`);
for (const e of absents) console.log(`  • ${e.chemin} : absent aujourd'hui, ignoré`);
if (alterations.length) sortir(3, "", "Sauvegarde altérée ou invalide : rien n'a été modifié.", ...alterations.map((r) => `  - ${r}`));
if (refus.length) sortir(4, "", "Restauration refusée par prudence :", ...refus.map((r) => `  - ${r}`));
if (!appliquer) sortir(0, "", "Aperçu seulement : rien n'a été modifié. Ajoutez --appliquer pour restaurer.");

// 4. Restauration.
if (windows) {
  const ps = win.executerPowerShell;
  const actuel = await win.inspecter(ps, { arbres: [racine] });
  if (!actuel.ok) sortir(5, `PowerShell indisponible (${actuel.code}) : rien n'a été modifié.`);
  const proprietairesModifies = presents.filter((e) => {
    const a = actuel.arbres[0].elements.find((x) => egaux(x.chemin, e.absolu));
    return a?.securite && e.securite?.proprietaire && a.securite.proprietaire !== e.securite.proprietaire;
  }).map((e) => e.absolu);
  const instantane = presents.map((e) => ({ chemin: e.absolu, dossier: e.type === "dossier", securite: { ...e.securite, sddl: e.sddl } }));
  const r = await win.restaurer({ racine, instantane, ps, proprietairesModifies, jeton });
  for (const j of r.journal || []) console.log(`  ! ${j.chemin} : propriétaire non rétabli (droits d'administrateur nécessaires)`);
  if (!r.ok) sortir(1, `Restauration ${r.etat} (étape : ${r.etape}${r.chemin ? `, ${r.chemin}` : ""}).`);
  sortir(0, "Restauration terminée et vérifiée (droits effectifs compris).");
} else {
  for (const e of [...presents].sort((a, b) => profondeur(b.chemin) - profondeur(a.chemin))) {
    const s = fs.lstatSync(e.absolu);
    if (s.isSymbolicLink()) sortir(1, `${e.absolu} est devenu un lien symbolique : arrêt.`);
    const mode = parseInt(e.mode, 8);
    const fd = fs.openSync(e.absolu, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { fs.fchmodSync(fd, mode); } finally { fs.closeSync(fd); }
    if ((fs.lstatSync(e.absolu).mode & 0o7777) !== mode) sortir(1, `${e.absolu} : droits non rétablis.`);
    console.log(`  ✓ ${e.chemin} : ${e.mode}`);
  }
  sortir(0, "Restauration terminée et vérifiée.");
}
