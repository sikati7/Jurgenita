// Restauration manuelle des droits du dossier des secrets depuis une
// sauvegarde (sous-étape 2b.4). Par défaut : APERÇU, rien n'est modifié.
//
//   node scripts/restaurer-droits-secrets.mjs <sauvegarde.json>              aperçu
//   node scripts/restaurer-droits-secrets.mjs <sauvegarde.json> --appliquer  restauration
//
// Garde-fous : la sauvegarde doit se trouver dans le dossier des sauvegardes,
// être protégée (aucun autre compte ne peut l'avoir remplacée) et sa chaîne
// de parents doit être sûre ; sinon, rien n'est appliqué et le contenu est
// affiché pour examen. Ordre : éléments contenus d'abord (du plus profond au
// moins profond), vérification, dossier principal en dernier, vérification
// finale. Les dossiers parents ne sont jamais modifiés.
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

const fichier = path.resolve(fichierArg);
const lu = readJsonFile(fichier);
if (lu.etat !== "ok") sortir(3, `Sauvegarde illisible : ${fichierArg} (${lu.etat}).`);
const sauvegarde = lu.valeur;
const racine = sd.secretsRoot();
const sauvegardes = sd.backupsDir();
const egaux = (a, b) => (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const reel = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

if (sauvegarde.version !== 1 || sauvegarde.plateforme !== process.platform) sortir(3, "Cette sauvegarde ne correspond pas à ce système.");
if (!egaux(sauvegarde.racine, racine)) sortir(3, `Cette sauvegarde concerne ${sauvegarde.racine}, pas le dossier des secrets actuel (${racine}).`);
if (!egaux(reel(path.dirname(fichier)), reel(sauvegardes))) sortir(3, `La sauvegarde doit se trouver dans ${sauvegardes}.`);

const absolu = (rel) => (rel === "." ? racine : path.join(racine, ...rel.split("/")));
const profondeur = (rel) => (rel === "." ? 0 : rel.split("/").length);
const elements = (sauvegarde.elements || []).map((e) => ({ ...e, absolu: absolu(e.chemin) }));
const presents = elements.filter((e) => fs.existsSync(e.absolu));
const absents = elements.filter((e) => !presents.includes(e));

// 1. Garde-fous : la sauvegarde est-elle protégée ?
async function garde() {
  const refus = [];
  if (process.platform === "win32") {
    const lu = await win.inspecter(win.executerPowerShell, { arbres: [sauvegardes], chemins: win.ancetres(sauvegardes) });
    if (!lu.ok) return [`PowerShell indisponible (${lu.code}).`];
    const jeton = win.construireJeton(lu.jeton, await win.executerWhoami(["/user", "/fo", "csv", "/nh"]), await win.executerWhoami(["/groups", "/fo", "csv", "/nh"]));
    if (!jeton.certain) refus.push(`Jeton incertain (${jeton.problemes.join(" ; ")}).`);
    const a = win.analyserArbre({ racine: sauvegardes, elements: lu.arbres[0].elements, jeton, noms: lu.noms });
    if (!a.conforme) refus.push("Le dossier des sauvegardes n'est pas protégé (vous, SYSTEM, Administrateurs uniquement) : un autre compte a pu modifier la sauvegarde.");
    refus.push(...a.problemes.map((p) => p.message));
    refus.push(...win.analyserChaine({ sensible: sauvegardes, elements: [...lu.chemins, ...lu.arbres[0].elements], jeton, noms: lu.noms }).map((p) => p.message));
  } else {
    const vue = sd.vuePosix();
    const moi = sd.moiPosix();
    const plateforme = process.platform;
    const groupe = plateforme === "darwin" ? sd.groupesMac() : sd.groupesLinux();
    const acl = plateforme === "darwin" ? sd.aclMac() : sd.aclLinux();
    const a = sd.analyserArbrePosix({ racine: sauvegardes, vue, moi, plateforme, acl });
    if (a.aCorriger.length) refus.push(`Le dossier des sauvegardes est accessible à d'autres comptes (${a.aCorriger.map((c) => c.chemin).join(", ")}) : un autre compte a pu modifier la sauvegarde.`);
    refus.push(...a.problemes.map((p) => p.message));
    refus.push(...sd.analyserChainePosix({ sensible: sauvegardes, vue, moi, groupe, acl, plateforme }).map((p) => p.message));
  }
  return refus;
}

// 2. Aperçu.
function decrire(e) {
  if (process.platform !== "win32") return `${e.chemin} → droits ${e.mode}`;
  const s = e.securite || {};
  const explicites = (s.entrees || []).filter((x) => !(x.drapeaux & 0x10)).length;
  return `${e.chemin} → ${s.protegee ? "héritage coupé" : "héritage actif"}, ${explicites} autorisation(s) explicite(s), propriétaire ${s.proprietaire}`;
}

const refus = await garde();
console.log(`Sauvegarde : ${fichier}`);
console.log(`Dossier des secrets : ${racine}`);
console.log("Ordre de restauration : éléments contenus (du plus profond au moins profond), puis le dossier principal.");
for (const e of [...presents].sort((a, b) => profondeur(b.chemin) - profondeur(a.chemin))) console.log(`  • ${decrire(e)}`);
for (const e of absents) console.log(`  • ${e.chemin} : absent aujourd'hui, ignoré`);
if (refus.length) sortir(4, "", "Restauration refusée par prudence :", ...refus.map((r) => `  - ${r}`));
if (!appliquer) sortir(0, "", "Aperçu seulement : rien n'a été modifié. Ajoutez --appliquer pour restaurer.");

// 3. Restauration.
if (process.platform === "win32") {
  const ps = win.executerPowerShell;
  const actuel = await win.inspecter(ps, { arbres: [racine] });
  if (!actuel.ok) sortir(5, `PowerShell indisponible (${actuel.code}) : rien n'a été modifié.`);
  const proprietairesModifies = presents.filter((e) => {
    const a = actuel.arbres[0].elements.find((x) => egaux(x.chemin, e.absolu));
    return a?.securite && e.securite?.proprietaire && a.securite.proprietaire !== e.securite.proprietaire;
  }).map((e) => e.absolu);
  const instantane = presents.map((e) => ({ chemin: e.absolu, dossier: e.type === "dossier", securite: { ...e.securite, sddl: e.sddl } }));
  const r = await win.restaurer({ racine, instantane, ps, proprietairesModifies });
  for (const j of r.journal || []) console.log(`  ! ${j.chemin} : propriétaire non rétabli (droits d'administrateur nécessaires)`);
  if (!r.ok) sortir(1, `Restauration ${r.etat} (étape : ${r.etape}${r.chemin ? `, ${r.chemin}` : ""}).`);
  sortir(0, "Restauration terminée et vérifiée.");
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
