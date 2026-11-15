// Restauration manuelle des droits du dossier des secrets depuis une
// sauvegarde (sous-étape 2b.4). Par défaut : APERÇU, rien n'est modifié.
//
//   node scripts/restaurer-droits-secrets.mjs <sauvegarde.json>              aperçu
//   node scripts/restaurer-droits-secrets.mjs <sauvegarde.json> --appliquer  restauration
//
// Garde-fous, tous vérifiés avant d'appliquer quoi que ce soit :
// - acquisition : le fichier de sauvegarde est contrôlé AVANT d'être lu, puis lu
//   depuis le même descripteur (Linux, macOS) ; sous Windows, le dossier des
//   sauvegardes est vérifié protégé avant toute lecture du contenu ;
// - contenu : version, système, dossier des secrets, chemins (jamais hors du
//   dossier des secrets), types et droits valides (ni setuid ni setgid) ; sous
//   Windows, les autorisations à appliquer (SDDL), relues par Windows, doivent
//   décrire exactement l'état enregistré à côté ;
// - protection : la sauvegarde se trouve dans le dossier des sauvegardes, qui
//   est protégé ; le fichier de sauvegarde lui-même n'appartient qu'à vous (ou
//   à SYSTEM, Administrateurs) et n'a que les autorisations attendues ; la
//   chaîne des dossiers parents du dossier des sauvegardes ET du dossier des
//   secrets est sûre ;
// - état actuel : chaque élément à restaurer a gardé son type, n'est pas devenu
//   un lien, garde la même identité (dev/ino sous Linux et macOS) et vous
//   appartient (Linux, macOS).
// Une sauvegarde altérée est refusée. Ordre : éléments contenus d'abord (du
// plus profond au moins profond), vérification, dossier principal en dernier,
// vérification finale (droits effectifs compris). Les dossiers parents ne sont
// jamais modifiés.
// Codes de sortie : 0 aperçu ou restauration vérifiée, 1 échec, 2 usage,
// 3 sauvegarde altérée, invalide ou d'un autre dossier, 4 refus par prudence,
// 5 PowerShell indisponible.
import fs from "node:fs";
import path from "node:path";
import * as sd from "../src/secret-dir.js";
import * as win from "../src/secret-dir-windows.js";

const args = process.argv.slice(2);
const appliquer = args.includes("--appliquer");
const fichierArg = args.find((a) => !a.startsWith("--"));
const sortir = (code, ...lignes) => { for (const l of lignes) (code ? console.error : console.log)(l); process.exit(code); };
if (!fichierArg) sortir(2, "Usage : node scripts/restaurer-droits-secrets.mjs <sauvegarde.json> [--appliquer]");

const windows = process.platform === "win32";
const fichier = path.resolve(fichierArg);
const racine = sd.secretsRoot();
const sauvegardes = sd.backupsDir();
const egaux = (a, b) => (windows ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const reel = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

// Emplacement : le fichier de sauvegarde doit se trouver dans le dossier des sauvegardes.
if (!egaux(reel(path.dirname(fichier)), reel(sauvegardes))) sortir(3, `La sauvegarde doit se trouver dans ${sauvegardes}.`);

// ---------------------------------------------------------------------------
// 1. Acquisition sûre du contenu de la sauvegarde.
// ---------------------------------------------------------------------------
// Linux, macOS : le fichier est ouvert sans suivre les liens (O_NOFOLLOW), son
// descripteur est vérifié (fichier ordinaire, propriétaire, droits réservés),
// puis lu depuis CE descripteur — jamais une seconde fois par le chemin.
function acquerirPosix() {
  const c = fs.constants;
  let fd;
  try { fd = fs.openSync(fichier, c.O_RDONLY | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0)); }
  catch (err) { return sortir(3, `Sauvegarde illisible : ${fichierArg} (${err.code}).`); }
  try {
    const s = fs.fstatSync(fd);
    const moi = process.getuid();
    if (!s.isFile()) sortir(3, "La sauvegarde n'est pas un fichier ordinaire.");
    if (s.uid !== moi && s.uid !== 0) sortir(4, "Restauration refusée par prudence :", `  - Sauvegarde altérée : le fichier appartient à un autre compte (uid ${s.uid}).`);
    if ((s.mode & 0o077) !== 0) sortir(4, "Restauration refusée par prudence :", `  - Sauvegarde altérée : le fichier est accessible à d'autres comptes (droits ${(s.mode & 0o777).toString(8)}).`);
    let texte;
    try { texte = fs.readFileSync(fd, "utf8"); } catch (err) { sortir(3, `Sauvegarde illisible (${err.code}).`); }
    try { return { sauvegarde: JSON.parse(texte) }; } catch { return sortir(3, "Sauvegarde illisible (JSON invalide)."); }
  } finally { try { fs.closeSync(fd); } catch { /* */ } }
}

// Windows : le dossier des sauvegardes et le fichier sont vérifiés protégés
// AVANT la lecture du contenu (un dossier protégé ne peut pas être remplacé par
// un autre compte pendant la lecture). L'inspection couvre aussi la chaîne des
// parents des deux dossiers (sauvegardes et secrets) pour le point 3.
async function acquerirWindows() {
  const ps = win.executerPowerShell;
  const chemins = [...new Set([...win.ancetres(sauvegardes), ...win.ancetres(racine), racine])];
  const luSv = await win.inspecter(ps, { arbres: [sauvegardes], chemins });
  if (!luSv.ok) sortir(5, `PowerShell indisponible (${luSv.code}) : rien n'a été modifié.`);
  const jeton = win.construireJeton(luSv.jeton, await win.executerWhoami(["/user", "/fo", "csv", "/nh"]), await win.executerWhoami(["/groups", "/fo", "csv", "/nh"]));
  if (!jeton.certain) sortir(4, "Restauration refusée par prudence :", `  - Jeton incertain (${jeton.problemes.join(" ; ")}).`);
  const elementsSv = luSv.arbres[0].elements;
  const a = win.analyserArbre({ racine: sauvegardes, elements: elementsSv, jeton, noms: luSv.noms });
  if (!a.conforme) sortir(4, "Restauration refusée par prudence :", "  - Le dossier des sauvegardes n'est pas protégé (vous, SYSTEM, Administrateurs uniquement) : un autre compte a pu modifier la sauvegarde.");
  const f = elementsSv.find((x) => egaux(x.chemin, fichier));
  if (!f || !f.existe) sortir(3, `Sauvegarde introuvable dans ${sauvegardes}.`);
  if (f.reparse) sortir(4, "Restauration refusée par prudence :", "  - Sauvegarde altérée : le fichier de sauvegarde est un lien ou une jonction.");
  if (!f.securite) sortir(4, "Restauration refusée par prudence :", "  - Autorisations du fichier de sauvegarde illisibles.");
  if (!win.proprietaireAutorise(f.securite, jeton)) sortir(4, "Restauration refusée par prudence :", `  - Sauvegarde altérée : le fichier appartient à ${win.nomCompte(f.securite.proprietaire, luSv.noms)}, pas à vous, SYSTEM ou Administrateurs.`);
  if (!win.enfantConforme(f.securite, jeton)) sortir(4, "Restauration refusée par prudence :", "  - Sauvegarde altérée : les autorisations du fichier ne sont plus celles attendues (vous, SYSTEM et Administrateurs, par héritage du dossier des sauvegardes).");
  // Dossier et fichier vérifiés : lecture du contenu.
  let texte;
  try { texte = fs.readFileSync(fichier, "utf8"); } catch (err) { sortir(3, `Sauvegarde illisible (${err.code}).`); }
  let sauvegarde;
  try { sauvegarde = JSON.parse(texte); } catch { sortir(3, "Sauvegarde illisible (JSON invalide)."); }
  return { sauvegarde, ps, luSv, jeton, elementsSv, noms: luSv.noms };
}

const acquis = windows ? await acquerirWindows() : acquerirPosix();
const sauvegarde = acquis.sauvegarde;

if (sauvegarde?.version !== 1 || sauvegarde?.plateforme !== process.platform) sortir(3, "Cette sauvegarde ne correspond pas à ce système.");
if (!egaux(sauvegarde.racine, racine)) sortir(3, `Cette sauvegarde concerne ${sauvegarde.racine}, pas le dossier des secrets actuel (${racine}).`);

// ---------------------------------------------------------------------------
// 2. Contenu de la sauvegarde.
// ---------------------------------------------------------------------------
const valide = sd.validerSauvegarde(sauvegarde, { racine });
if (!valide.ok) sortir(3, "Sauvegarde altérée ou invalide : rien n'a été modifié.", ...valide.erreurs.map((e) => `  - ${e}`));
const elements = valide.elements;
const etatActuel = new Map(); // absolu -> { dev, ino, dossier } relevé pendant la garde (Linux, macOS)
const presents = elements.filter((e) => lstat(e.absolu));
const absents = elements.filter((e) => !presents.includes(e));
const profondeur = (rel) => (rel === "." ? 0 : rel.split("/").length);

// ---------------------------------------------------------------------------
// 3. Protection (chaînes des parents des deux dossiers) et état actuel des éléments.
// ---------------------------------------------------------------------------
async function garde() {
  const refus = [];
  const alterations = [];
  if (windows) {
    const { ps, luSv, jeton, elementsSv, noms } = acquis;
    const chaineElements = [...luSv.chemins, ...elementsSv];
    // Chaîne des parents du dossier des sauvegardes ET du dossier des secrets (point 3).
    refus.push(...win.analyserChaine({ sensible: sauvegardes, elements: chaineElements, jeton, noms }).map((p) => p.message));
    const vusSecrets = new Set(refus);
    refus.push(...win.analyserChaine({ sensible: racine, elements: chaineElements, jeton, noms }).map((p) => p.message).filter((m) => !vusSecrets.has(m)));
    // Les autorisations à appliquer (SDDL) doivent décrire exactement l'état enregistré.
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
    // Dossier des sauvegardes : accessible à d'autres comptes ?
    const a = sd.analyserArbrePosix({ racine: sauvegardes, vue, moi, plateforme, acl });
    if (a.aCorriger.length) refus.push(`Le dossier des sauvegardes est accessible à d'autres comptes (${a.aCorriger.map((c) => c.chemin).join(", ")}) : un autre compte a pu modifier la sauvegarde.`);
    refus.push(...a.problemes.map((p) => p.message));
    // Chaîne des parents du dossier des sauvegardes ET du dossier des secrets (point 3).
    refus.push(...sd.analyserChainePosix({ sensible: sauvegardes, vue, moi, groupe, acl, plateforme }).map((p) => p.message));
    const vus = new Set(refus);
    refus.push(...sd.analyserChainePosix({ sensible: racine, vue, moi, groupe, acl, plateforme }).map((p) => p.message).filter((m) => !vus.has(m)));
  }
  // État actuel des éléments à restaurer.
  for (const e of presents) {
    const st = lstat(e.absolu);
    if (st.isSymbolicLink()) refus.push(`${e.chemin} est devenu un lien : restauration refusée.`);
    else if (st.isDirectory() !== (e.type === "dossier")) refus.push(`${e.chemin} n'est plus un ${e.type} : restauration refusée.`);
    else if (!windows && st.uid !== process.getuid() && process.getuid() !== 0) refus.push(`${e.chemin} appartient à un autre compte (uid ${st.uid}) : ses droits ne peuvent pas être rétablis.`);
    else etatActuel.set(e.absolu, { dev: st.dev, ino: st.ino, dossier: st.isDirectory() });
  }
  return { refus, alterations };
}

// ---------------------------------------------------------------------------
// 4. Aperçu.
// ---------------------------------------------------------------------------
function decrire(e) {
  if (!windows) return `${e.chemin} → droits ${e.mode}`;
  const s = e.securite || {};
  const explicites = (s.entrees || []).filter((x) => !(x.drapeaux & 0x10)).length;
  return `${e.chemin} → ${s.protegee ? "héritage coupé" : "héritage actif"}, ${explicites} autorisation(s) explicite(s), propriétaire ${s.proprietaire}`;
}

const { refus, alterations } = await garde();
console.log(`Sauvegarde : ${fichier}`);
console.log(`Dossier des secrets : ${racine}`);
console.log("Ordre de restauration : éléments contenus (du plus profond au moins profond), puis le dossier principal.");
for (const e of [...presents].sort((a, b) => profondeur(b.chemin) - profondeur(a.chemin))) console.log(`  • ${decrire(e)}`);
for (const e of absents) console.log(`  • ${e.chemin} : absent aujourd'hui, ignoré`);
if (alterations.length) sortir(3, "", "Sauvegarde altérée ou invalide : rien n'a été modifié.", ...alterations.map((r) => `  - ${r}`));
if (refus.length) sortir(4, "", "Restauration refusée par prudence :", ...refus.map((r) => `  - ${r}`));
if (!appliquer) sortir(0, "", "Aperçu seulement : rien n'a été modifié. Ajoutez --appliquer pour restaurer.");

// ---------------------------------------------------------------------------
// 5. Restauration.
// ---------------------------------------------------------------------------
if (windows) {
  const ps = acquis.ps;
  const actuel = await win.inspecter(ps, { arbres: [racine] });
  if (!actuel.ok) sortir(5, `PowerShell indisponible (${actuel.code}) : rien n'a été modifié.`);
  const courant = (p) => actuel.arbres[0].elements.find((x) => egaux(x.chemin, p));
  const proprietairesModifies = presents.filter((e) => {
    const a = courant(e.absolu);
    return a?.securite && e.securite?.proprietaire && a.securite.proprietaire !== e.securite.proprietaire;
  }).map((e) => e.absolu);
  // Instantané avec l'identité ACTUELLE de chaque objet : l'application vérifie,
  // sur une poignée, que l'objet n'a pas été remplacé depuis cette inspection.
  const instantane = presents.map((e) => ({ chemin: e.absolu, dossier: e.type === "dossier", id: courant(e.absolu)?.id, securite: { ...e.securite, sddl: e.sddl } }));
  if (instantane.some((e) => !e.id)) sortir(5, "Protection par poignée (handle) indisponible : rien n'a été modifié.");
  const r = await win.restaurer({ racine, instantane, ps, proprietairesModifies, jeton: acquis.jeton });
  for (const j of r.journal || []) console.log(`  ! ${j.chemin} : propriétaire non rétabli (droits d'administrateur nécessaires)`);
  if (!r.ok) sortir(1, `Restauration ${r.etat} (étape : ${r.etape}${r.chemin ? `, ${r.chemin}` : ""}).`);
  if ((r.journal || []).length) sortir(1, "Restauration des droits terminée, mais un ou plusieurs propriétaires d'origine n'ont pas pu être rétablis (droits d'administrateur nécessaires).");
  sortir(0, "Restauration terminée et vérifiée (droits effectifs compris).");
} else {
  const c = fs.constants;
  for (const e of [...presents].sort((a, b) => profondeur(b.chemin) - profondeur(a.chemin))) {
    const mode = parseInt(e.mode, 8);
    const attendu = etatActuel.get(e.absolu) || {};
    let fd;
    try { fd = fs.openSync(e.absolu, c.O_RDONLY | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0) | (e.type === "dossier" && c.O_DIRECTORY ? c.O_DIRECTORY : 0)); }
    catch (err) { sortir(1, `${e.absolu} : ouverture sécurisée impossible (${err.code}) : arrêt.`); }
    try {
      const s = fs.fstatSync(fd);
      const memeType = e.type === "dossier" ? s.isDirectory() : s.isFile();
      const memeObjet = (attendu.dev === undefined || s.dev === attendu.dev) && (attendu.ino === undefined || s.ino === attendu.ino);
      if (!memeType || !memeObjet) sortir(1, `${e.absolu} a été remplacé depuis la vérification : arrêt.`);
      fs.fchmodSync(fd, mode);
      if ((fs.fstatSync(fd).mode & 0o7777) !== mode) sortir(1, `${e.absolu} : droits non rétablis.`);
    } finally { try { fs.closeSync(fd); } catch { /* */ } }
    console.log(`  ✓ ${e.chemin} : ${e.mode}`);
  }
  sortir(0, "Restauration terminée et vérifiée.");
}
