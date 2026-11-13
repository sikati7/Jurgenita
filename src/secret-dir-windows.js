// Protection Windows des dossiers de secrets (sous-étape 2b.4).
//
// - Tout raisonnement se fait par SID, indépendant de la langue de Windows.
// - Lecture et écriture des ACL par l'API .NET de Windows PowerShell 5.1.
//   Le script est passé en argument de -Command : aucun fichier .ps1 (donc
//   indépendant de la stratégie d'exécution), pas de -EncodedCommand. Les
//   paramètres passent par des variables d'environnement, le résultat revient
//   en JSON ASCII. Les scripts ne contiennent aucun guillemet double, pour que
//   la ligne de commande Windows ne puisse pas les altérer.
// - L'analyse (descripteurs, jeton, droits effectifs, chaîne des parents,
//   conformité, ordre des opérations) est faite ici en JavaScript, testable
//   sans Windows.
// - Toute incertitude arrête la correction automatique. Les dossiers parents
//   ne sont jamais modifiés.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { TEMP_SUFFIX } from "./atomic-file.js";

const wpath = path.win32;

export const SID = {
  SYSTEME: "S-1-5-18",
  ADMINISTRATEURS: "S-1-5-32-544",
  UTILISATEURS: "S-1-5-32-545",
  UTILISATEURS_AUTHENTIFIES: "S-1-5-11",
  TOUT_LE_MONDE: "S-1-1-0",
  TRUSTED_INSTALLER: "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
  CREATEUR_PROPRIETAIRE: "S-1-3-0",
  GROUPE_CREATEUR: "S-1-3-1",
  DROITS_DU_PROPRIETAIRE: "S-1-3-4",
};

// Droits NTFS utiles ici.
export const DROIT = {
  LECTURE_DONNEES: 0x1,
  AJOUT_FICHIER: 0x2,
  AJOUT_SOUS_DOSSIER: 0x4,
  SUPPRESSION_CONTENU: 0x40, // DELETE_CHILD
  SUPPRESSION: 0x10000, // DELETE
  LECTURE_ACL: 0x20000,
  MODIFICATION_ACL: 0x40000, // WRITE_DAC
  PRISE_PROPRIETE: 0x80000, // WRITE_OWNER
  CONTROLE_TOTAL: 0x1f01ff, // FILE_ALL_ACCESS
};
const ACE_AUTORISER = 0;
const ACE_REFUSER = 1;
const OI = 0x01;
const CI = 0x02;
const NP = 0x04;
const IO = 0x08;
const HERITE = 0x10;

const NOMS_DROITS = [
  [DROIT.SUPPRESSION, "suppression (DELETE)"],
  [DROIT.SUPPRESSION_CONTENU, "suppression de son contenu (DELETE_CHILD)"],
  [DROIT.MODIFICATION_ACL, "modification des autorisations (WRITE_DAC)"],
  [DROIT.PRISE_PROPRIETE, "prise de possession (WRITE_OWNER)"],
];
const nomsDroits = (m) => NOMS_DROITS.filter(([bit]) => m & bit).map(([, n]) => n).join(", ");

// Droits génériques convertis en droits de fichiers (comme le fait Windows).
export function droitsReels(masque) {
  const m = masque >>> 0;
  let r = m & 0x001fffff;
  if (m & 0x80000000) r |= 0x120089; // GENERIC_READ
  if (m & 0x40000000) r |= 0x120116; // GENERIC_WRITE
  if (m & 0x20000000) r |= 0x1200a0; // GENERIC_EXECUTE
  if (m & 0x10000000) r |= 0x1f01ff; // GENERIC_ALL
  return r >>> 0;
}

// ---------------------------------------------------------------------------
// Droits effectifs de l'utilisateur courant, calculés comme le fait Windows :
// ordre de la liste, refus prioritaire sur ce qui n'est pas encore accordé,
// droits implicites du propriétaire (sauf entrée « OWNER RIGHTS »), entrées
// « héritage seulement » ignorées pour l'objet lui-même.
// Les autorisations ne comptent que les groupes ACTIFS du jeton ; les refus
// comptent aussi les groupes « réservés au refus » (contrôle de compte).
// ---------------------------------------------------------------------------
export function droitsEffectifs(securite, jeton) {
  if (!securite) return 0;
  if (securite.nulle) return DROIT.CONTROLE_TOTAL;
  const autorises = new Set([jeton.utilisateur, ...jeton.actifs]);
  const refusables = new Set([...autorises, ...jeton.refus]);
  const proprietaire = autorises.has(securite.proprietaire);
  const entrees = securite.entrees || [];
  const droitsProprietaire = entrees.some((e) => e.sid === SID.DROITS_DU_PROPRIETAIRE && !(e.drapeaux & IO));
  let accordes = proprietaire && !droitsProprietaire ? DROIT.LECTURE_ACL | DROIT.MODIFICATION_ACL : 0;
  let refuses = 0;
  for (const e of entrees) {
    if (e.drapeaux & IO) continue;
    if (e.type !== ACE_AUTORISER && e.type !== ACE_REFUSER) continue;
    const concerne = e.sid === SID.DROITS_DU_PROPRIETAIRE ? proprietaire : (e.type === ACE_REFUSER ? refusables : autorises).has(e.sid);
    if (!concerne) continue;
    const m = droitsReels(e.masque);
    if (e.type === ACE_REFUSER) refuses = (refuses | (m & ~accordes)) >>> 0;
    else accordes = (accordes | (m & ~refuses)) >>> 0;
  }
  return accordes >>> 0;
}

// ---------------------------------------------------------------------------
// Jeton de sécurité : deux sources indépendantes.
// - whoami (outil natif) : TOUS les SID du jeton, imbrications comprises
//   (groupes locaux, de domaine, implicites, réservés au refus) ; libellés
//   traduits mais SID non traduits.
// - .NET WindowsIdentity : utilisateur, groupes actifs, groupes réservés au refus.
// Un échec ou un désaccord = incertitude.
// ---------------------------------------------------------------------------
export function lireCsv(ligne) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (q) {
      if (c === '"') { if (ligne[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}
export const estSid = (s) => /^S-1-\d+(-\d+)+$/.test(s || "");

export function construireJeton(jetonNet, sortieWhoamiUtilisateur, sortieWhoamiGroupes) {
  const problemes = [];
  const notes = [];
  const lignes = (t) => String(t || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const utilisateurWhoami = lignes(sortieWhoamiUtilisateur).map(lireCsv).map((f) => f[f.length - 1]).find(estSid);
  const groupesWhoami = lignes(sortieWhoamiGroupes).map(lireCsv).map((f) => f[2]).filter(estSid);
  if (!jetonNet || !estSid(jetonNet.utilisateur)) problemes.push("jeton .NET illisible");
  if (!utilisateurWhoami) problemes.push("whoami /user illisible");
  if (!groupesWhoami.length) problemes.push("whoami /groups illisible");
  if (jetonNet && utilisateurWhoami && jetonNet.utilisateur !== utilisateurWhoami) problemes.push("utilisateur différent selon whoami et .NET");
  // SID de session de connexion et étiquettes d'intégrité : présents dans le jeton, jamais dans une ACL de fichier utile ici.
  const vusWhoami = new Set(groupesWhoami.filter((s) => !/^S-1-5-5-/.test(s) && !/^S-1-16-/.test(s)));
  const actifs = new Set((jetonNet?.actifs || []).filter(estSid));
  const refusNet = (jetonNet?.refus || []).filter(estSid);
  // whoami n'affiche pas tous les groupes du jeton (par exemple le groupe local
  // « Aucun », RID 513, que .NET lit) : les deux lectures sont réunies. Cela ne
  // fait qu'élargir les SID pris en compte pour les règles de refus.
  const absents = [...actifs].filter((s) => !vusWhoami.has(s));
  if (absents.length) notes.push(`groupes lus par .NET et non affichés par whoami : ${absents.join(", ")}`);
  const tous = new Set([...vusWhoami, ...actifs, ...refusNet]);
  // Tout SID du jeton qui n'est pas un groupe actif compte pour les refus (prudence).
  const refus = new Set([...refusNet, ...[...vusWhoami].filter((s) => !actifs.has(s))]);
  return {
    utilisateur: jetonNet?.utilisateur || utilisateurWhoami || null,
    actifs: [...actifs],
    refus: [...refus],
    tous: [...tous],
    certain: problemes.length === 0,
    problemes,
    notes,
  };
}

// ---------------------------------------------------------------------------
// PowerShell
// ---------------------------------------------------------------------------
const PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output ('@@JG@@' + (ConvertTo-Json -InputObject @{ ok = $false; code = 'langage_restreint' } -Compress))
  exit 0
}
function Out-Jg($o) {
  $j = ConvertTo-Json -InputObject $o -Compress -Depth 12
  $j = [regex]::Replace($j, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.Write('@@JG@@' + $j)
}
$sections = [System.Security.AccessControl.AccessControlSections]'Owner, Access'
$noms = @{}
function Add-Nom($sid) {
  if (-not $sid -or $noms.ContainsKey($sid)) { return }
  $noms[$sid] = $null
  if ($sid -like 'S-1-5-21-*' -and $sid -ne $script:moi) { return }
  try { $noms[$sid] = ([System.Security.Principal.SecurityIdentifier]::new($sid)).Translate([System.Security.Principal.NTAccount]).Value } catch { }
}
function Read-Sec($acl) {
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  $f = [int]$raw.ControlFlags
  $s = @{ sddl = $acl.GetSecurityDescriptorSddlForm($sections); proprietaire = $null; protegee = (($f -band 4096) -ne 0); nulle = $false; entrees = @() }
  if ($raw.Owner) { $s.proprietaire = $raw.Owner.Value; Add-Nom $s.proprietaire }
  if ((($f -band 4) -eq 0) -or ($null -eq $raw.DiscretionaryAcl)) { $s.nulle = $true }
  else {
    $l = New-Object System.Collections.ArrayList
    foreach ($a in $raw.DiscretionaryAcl) {
      $e = @{ type = [int]$a.AceType; drapeaux = [int]$a.AceFlags; masque = $null; sid = $null }
      if ($a -is [System.Security.AccessControl.KnownAce]) { $e.masque = [int]$a.AccessMask; $e.sid = $a.SecurityIdentifier.Value; Add-Nom $e.sid }
      [void]$l.Add($e)
    }
    $s.entrees = $l.ToArray()
  }
  return $s
}
function Read-Item($p) {
  $r = @{ chemin = $p; existe = $false }
  try { $a = [System.IO.File]::GetAttributes($p) }
  catch [System.IO.FileNotFoundException] { return $r }
  catch [System.IO.DirectoryNotFoundException] { return $r }
  catch { $r.existe = $true; $r.erreur = $_.Exception.GetType().Name; return $r }
  $r.existe = $true
  $r.dossier = (($a -band [System.IO.FileAttributes]::Directory) -ne 0)
  $r.reparse = (($a -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
  try {
    if ($r.dossier) { $acl = [System.IO.Directory]::GetAccessControl($p, $sections) } else { $acl = [System.IO.File]::GetAccessControl($p, $sections) }
    $r.securite = Read-Sec $acl
  } catch { $r.erreur = $_.Exception.GetType().Name }
  return $r
}
function Read-Jeton() {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $j = @{ utilisateur = $id.User.Value; actifs = @($id.Groups | ForEach-Object { $_.Value }); refus = @(); refusConnu = $false }
  try { $j.refus = @($id.Claims | Where-Object { $_.Type -eq 'http://schemas.microsoft.com/ws/2008/06/identity/claims/denyonlysid' } | ForEach-Object { $_.Value }); $j.refusConnu = $true } catch { }
  return $j
}
`;

const SCRIPT_INSPECTER = `${PRELUDE}
function Walk($dir, $list) {
  try { $entrees = [System.IO.Directory]::GetFileSystemEntries($dir) }
  catch { [void]$list.Add(@{ chemin = $dir; existe = $true; listeImpossible = $_.Exception.GetType().Name }); return }
  foreach ($e in $entrees) {
    $it = Read-Item $e
    [void]$list.Add($it)
    if ($it.existe -and $it.dossier -and -not $it.reparse -and -not $it.erreur) { Walk $e $list }
  }
}
function Read-Volume($p) {
  $v = @{ chemin = $p }
  try {
    $root = [System.IO.Path]::GetPathRoot($p)
    $v.racine = $root
    $d = [System.IO.DriveInfo]::new($root)
    $v.format = $d.DriveFormat
    $v.type = [string]$d.DriveType
  } catch { $v.erreur = $_.Exception.GetType().Name }
  return $v
}
$in = $env:JG_ENTREE | ConvertFrom-Json
$jeton = Read-Jeton
$script:moi = $jeton.utilisateur
Add-Nom $jeton.utilisateur
$arbres = New-Object System.Collections.ArrayList
foreach ($t in $in.arbres) {
  $list = New-Object System.Collections.ArrayList
  $racine = Read-Item $t
  [void]$list.Add($racine)
  if ($racine.existe -and $racine.dossier -and -not $racine.reparse -and -not $racine.erreur) { Walk $t $list }
  [void]$arbres.Add(@{ racine = $t; elements = $list.ToArray(); volume = (Read-Volume $t) })
}
$chemins = New-Object System.Collections.ArrayList
foreach ($c in $in.chemins) { [void]$chemins.Add((Read-Item $c)) }
Out-Jg @{ ok = $true; jeton = $jeton; arbres = $arbres.ToArray(); chemins = $chemins.ToArray(); noms = $noms }
`;

const SCRIPT_APPLIQUER = `${PRELUDE}
$in = $env:JG_OPERATIONS | ConvertFrom-Json
$res = New-Object System.Collections.ArrayList
foreach ($op in $in.ops) {
  try {
    $dir = [System.IO.Directory]::Exists($op.chemin)
    if ($dir) { $s = New-Object System.Security.AccessControl.DirectorySecurity } else { $s = New-Object System.Security.AccessControl.FileSecurity }
    if ($op.action -eq 'proprietaire') { $s.SetOwner([System.Security.Principal.SecurityIdentifier]::new($op.sid)) }
    elseif ($op.action -eq 'dacl') { $s.SetSecurityDescriptorSddlForm($op.sddl, [System.Security.AccessControl.AccessControlSections]::Access) }
    else { throw 'action inconnue' }
    if ($dir) { [System.IO.Directory]::SetAccessControl($op.chemin, $s) } else { [System.IO.File]::SetAccessControl($op.chemin, $s) }
    [void]$res.Add(@{ ok = $true })
  } catch {
    [void]$res.Add(@{ ok = $false; erreur = $_.Exception.GetType().Name; message = [string]$_.Exception.Message })
    break
  }
}
Out-Jg @{ ok = $true; resultats = $res.ToArray() }
`;

const SCRIPT_DIAGNOSTIQUER = `${PRELUDE}
$in = $env:JG_ENTREE | ConvertFrom-Json
$f = $in.fichier
$jeton = Read-Jeton
$script:moi = $jeton.utilisateur
$r = @{ ok = $true; jeton = $jeton; fichier = (Read-Item $f); dossier = (Read-Item ([System.IO.Path]::GetDirectoryName($f))); ouverture = 'absent' }
if ($r.fichier.existe -and -not $r.fichier.dossier) {
  try {
    $fs = [System.IO.FileStream]::new($f, [System.IO.FileMode]::Open, [System.Security.AccessControl.FileSystemRights]'ReadData, WriteData', [System.IO.FileShare]'ReadWrite, Delete', 4096, [System.IO.FileOptions]::None)
    $fs.Close()
    $r.ouverture = 'ok'
  } catch [System.UnauthorizedAccessException] { $r.ouverture = 'refuse' }
    catch [System.IO.IOException] { $r.ouverture = 'occupe'; $r.hresult = $_.Exception.HResult }
    catch { $r.ouverture = 'erreur'; $r.typeErreur = $_.Exception.GetType().Name }
}
Out-Jg $r
`;

// Lecture, par Windows lui-même, des ACL enregistrées dans une sauvegarde (SDDL),
// pour vérifier qu'elles décrivent bien l'état enregistré à côté.
const SCRIPT_CONVERTIR = `${PRELUDE}
$in = $env:JG_ENTREE | ConvertFrom-Json
$res = New-Object System.Collections.ArrayList
foreach ($t in $in.sddl) {
  try {
    $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new([string]$t)
    $f = [int]$raw.ControlFlags
    $s = @{ proprietaire = $null; protegee = (($f -band 4096) -ne 0); nulle = $false; entrees = @() }
    if ($raw.Owner) { $s.proprietaire = $raw.Owner.Value }
    if ((($f -band 4) -eq 0) -or ($null -eq $raw.DiscretionaryAcl)) { $s.nulle = $true }
    else {
      $l = New-Object System.Collections.ArrayList
      foreach ($a in $raw.DiscretionaryAcl) {
        $e = @{ type = [int]$a.AceType; drapeaux = [int]$a.AceFlags; masque = $null; sid = $null }
        if ($a -is [System.Security.AccessControl.KnownAce]) { $e.masque = [int]$a.AccessMask; $e.sid = $a.SecurityIdentifier.Value }
        [void]$l.Add($e)
      }
      $s.entrees = $l.ToArray()
    }
    [void]$res.Add(@{ ok = $true; securite = $s })
  } catch { [void]$res.Add(@{ ok = $false; erreur = $_.Exception.GetType().Name }) }
}
Out-Jg @{ ok = $true; resultats = $res.ToArray() }
`;

export const SCRIPTS = { inspecter: SCRIPT_INSPECTER, appliquer: SCRIPT_APPLIQUER, diagnostiquer: SCRIPT_DIAGNOSTIQUER, convertir: SCRIPT_CONVERTIR };

// Outils système appelés par leur chemin complet, jamais par le PATH : pas
// d'homonyme (Git Bash fournit son propre whoami) ni de programme placé plus
// tôt dans le PATH pour fausser le jeton ou les autorisations lues.
const racineSysteme = () => process.env.SystemRoot || process.env.windir || "C:\\Windows";
export const cheminPowerShell = () => wpath.join(racineSysteme(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
export const cheminWhoami = () => wpath.join(racineSysteme(), "System32", "whoami.exe");

// Environnement de Windows PowerShell 5.1 : sans le PSModulePath hérité (lancé
// depuis PowerShell 7, il désigne des modules incompatibles avec la version 5.1).
export function environnementPowerShell(env = {}) {
  const e = { ...process.env, ...env };
  for (const k of Object.keys(e)) if (k.toLowerCase() === "psmodulepath") delete e[k];
  return e;
}

export function executerPowerShell(nom, env = {}, { delaiMs = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(cheminPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPTS[nom]], {
      env: environnementPowerShell(env), windowsHide: true, timeout: delaiMs, maxBuffer: 32 * 1024 * 1024, encoding: "latin1",
    }, (err, stdout) => {
      const i = stdout ? stdout.lastIndexOf("@@JG@@") : -1;
      if (i < 0) return resolve({ ok: false, code: err?.killed ? "delai_depasse" : "powershell_indisponible", detail: err ? String(err.code || "").slice(0, 80) : "sortie vide" });
      try { resolve(JSON.parse(stdout.slice(i + 6).trim())); } catch { resolve({ ok: false, code: "sortie_illisible" }); }
    });
  });
}

export function executerWhoami(args, { delaiMs = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(cheminWhoami(), args, { windowsHide: true, timeout: delaiMs, encoding: "latin1" }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------
export function ancetres(p) {
  const out = [];
  let cur = wpath.dirname(p);
  for (;;) {
    out.push(cur);
    const parent = wpath.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}
export const wpathJoin = (...morceaux) => wpath.join(...morceaux);
export const relatifWin = (racine, p) => { const x = wpath.relative(racine, p); return x ? x.split("\\").join("/") : "."; };
const memeChemin = (a, b) => wpath.resolve(a).toLowerCase() === wpath.resolve(b).toLowerCase();
const profondeur = (p) => wpath.resolve(p).split(/[\\/]+/).filter(Boolean).length;
const liste = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function normaliserElement(e) {
  if (!e) return e;
  const s = e.securite;
  if (s) s.entrees = liste(s.entrees).map((x) => ({ ...x, masque: x.masque === null || x.masque === undefined ? null : x.masque >>> 0 }));
  return e;
}

export function nomCompte(sid, noms) {
  const n = noms?.[sid];
  return n ? `${n} (${sid})` : sid;
}

// Cible : dossier principal protégé, trois autorisations « contrôle total »
// héritées par les sous-dossiers et les fichiers.
export const sddlCible = (utilisateur) => `D:P(A;OICI;FA;;;${utilisateur})(A;OICI;FA;;;${SID.SYSTEME})(A;OICI;FA;;;${SID.ADMINISTRATEURS})`;
export const SDDL_HERITAGE_SEUL = "D:AI";

const autorisesCible = (jeton) => new Set([jeton.utilisateur, SID.SYSTEME, SID.ADMINISTRATEURS]);
const confiancesParents = (jeton) => new Set([jeton.utilisateur, SID.SYSTEME, SID.ADMINISTRATEURS, SID.TRUSTED_INSTALLER]);

// Entrées inexploitables avec certitude (objet, rappel, conditionnelles…).
function entreesNonPrises(securite) {
  return liste(securite?.entrees).filter((e) => (e.type !== ACE_AUTORISER && e.type !== ACE_REFUSER) || !estSid(e.sid) || e.masque === null);
}

export function racineConforme(securite, jeton) {
  if (!securite || securite.nulle || !securite.protegee) return false;
  const attendus = autorisesCible(jeton);
  const e = liste(securite.entrees);
  if (e.length !== 3) return false;
  const vus = new Set();
  for (const x of e) {
    if (x.type !== ACE_AUTORISER || (x.drapeaux & 0x1f) !== (OI | CI) || (x.masque >>> 0) !== DROIT.CONTROLE_TOTAL || !attendus.has(x.sid)) return false;
    vus.add(x.sid);
  }
  return vus.size === 3;
}

export function enfantConforme(securite, jeton) {
  if (!securite || securite.nulle || securite.protegee) return false;
  const e = liste(securite.entrees);
  if (e.some((x) => !(x.drapeaux & HERITE))) return false; // aucune entrée explicite
  const attendus = autorisesCible(jeton);
  const effectives = e.filter((x) => !(x.drapeaux & IO));
  const vus = new Set();
  for (const x of effectives) {
    if (x.type !== ACE_AUTORISER || droitsReels(x.masque) !== DROIT.CONTROLE_TOTAL || !attendus.has(x.sid)) return false;
    vus.add(x.sid);
  }
  return vus.size === 3;
}

export const proprietaireAutorise = (securite, jeton) => autorisesCible(jeton).has(securite?.proprietaire);

// Accès d'autres comptes (pour le rapport) : autorisations effectives d'un SID
// autre que les trois comptes autorisés.
function accesAutres(securite, jeton) {
  if (securite?.nulle) return [{ sid: SID.TOUT_LE_MONDE, masque: DROIT.CONTROLE_TOTAL }];
  const autorises = autorisesCible(jeton);
  return liste(securite?.entrees).filter((e) => e.type === ACE_AUTORISER && !(e.drapeaux & IO) && estSid(e.sid)
    && !autorises.has(e.sid) && e.sid !== SID.CREATEUR_PROPRIETAIRE && e.sid !== SID.GROUPE_CREATEUR
    && !(e.sid === SID.DROITS_DU_PROPRIETAIRE && proprietaireAutorise(securite, jeton)));
}

// ---------------------------------------------------------------------------
// Chaîne des parents : un autre compte peut-il supprimer, renommer, remplacer
// ou réécrire les droits d'un élément de la chaîne ? Évaluation prudente,
// entrée par entrée (les jetons des autres comptes sont inconnus) : toute
// autorisation dangereuse à un compte non fiable compte, les refus ne sont
// pas crédités. Retour : liste de problèmes { niveau, code, message }.
// ---------------------------------------------------------------------------
export function analyserChaine({ sensible, elements, jeton, noms }) {
  const problemes = [];
  const fiables = confiancesParents(jeton);
  const element = (p) => elements.find((e) => e && !e.listeImpossible && memeChemin(e.chemin, p));
  const nonFiable = (sid, securite) => {
    if (sid === SID.CREATEUR_PROPRIETAIRE || sid === SID.GROUPE_CREATEUR) return false; // ne correspond jamais à un jeton
    if (sid === SID.DROITS_DU_PROPRIETAIRE) return !fiables.has(securite?.proprietaire);
    return !fiables.has(sid);
  };
  const dangereuses = (securite, droits) => liste(securite?.entrees).filter((e) => e.type === ACE_AUTORISER && !(e.drapeaux & IO)
    && estSid(e.sid) && nonFiable(e.sid, securite) && (droitsReels(e.masque) & droits));
  // Chaque dossier de la chaîne n'est contrôlé qu'une fois pour sa lisibilité.
  const lus = new Map();
  const lisible = (x, chemin) => {
    const cle = wpath.resolve(chemin).toLowerCase();
    if (lus.has(cle)) return lus.get(cle);
    let ok = true;
    if (!x || !x.existe) { problemes.push({ niveau: "incertain", code: "chaine_illisible", message: `Dossier de la chaîne introuvable ou non lu : ${chemin}.` }); ok = false; }
    else if (x.erreur || !x.securite) { problemes.push({ niveau: "incertain", code: "chaine_illisible", message: `Autorisations illisibles sur ${chemin} (${x.erreur || "inconnu"}).` }); ok = false; }
    else {
      if (x.reparse) problemes.push({ niveau: "incertain", code: "chaine_lien", message: `${chemin} est un lien ou une jonction : vérification impossible avec certitude.` });
      if (entreesNonPrises(x.securite).length) problemes.push({ niveau: "incertain", code: "chaine_entree_inconnue", message: `${chemin} contient des entrées d'autorisation non évaluables (conditionnelles, objet ou inconnues).` });
      if (x.securite.nulle) problemes.push({ niveau: "dangereux", code: "chaine_sans_acl", message: `${chemin} n'a aucune liste d'autorisations : tout le monde peut le modifier.` });
    }
    lus.set(cle, ok);
    return ok;
  };
  for (const cible of [sensible, ...ancetres(sensible)]) {
    const parent = wpath.dirname(cible);
    if (parent === cible) break; // racine du disque : ne peut pas être renommée
    const estSensible = memeChemin(cible, sensible);
    const e = element(cible);
    const p = element(parent);
    // Le dossier sensible lui-même est analysé (et corrigé) à part ; ici, seul
    // compte ce que ses parents permettent à d'autres comptes.
    if (!estSensible && lisible(e, cible)) {
      if (nonFiable(e.securite.proprietaire, e.securite) && e.securite.proprietaire !== SID.DROITS_DU_PROPRIETAIRE) {
        problemes.push({ niveau: "dangereux", code: "parent_proprietaire", message: `Le dossier parent ${cible} appartient à ${nomCompte(e.securite.proprietaire, noms)}, qui peut en réécrire les autorisations.` });
      }
      for (const x of dangereuses(e.securite, DROIT.SUPPRESSION | DROIT.MODIFICATION_ACL | DROIT.PRISE_PROPRIETE)) {
        problemes.push({ niveau: "dangereux", code: "parent_droits", message: `${nomCompte(x.sid, noms)} a sur le dossier parent ${cible} : ${nomsDroits(droitsReels(x.masque))}${x.drapeaux & HERITE ? " (hérité)" : " (explicite)"}. Ce compte peut le renommer ou le remplacer.` });
      }
    }
    if (lisible(p, parent)) {
      for (const x of dangereuses(p.securite, DROIT.SUPPRESSION_CONTENU)) {
        problemes.push({ niveau: "dangereux", code: "parent_suppression_contenu", message: `${nomCompte(x.sid, noms)} a sur ${parent} : ${nomsDroits(DROIT.SUPPRESSION_CONTENU)}${x.drapeaux & HERITE ? " (hérité)" : " (explicite)"}. Ce compte peut supprimer ou déplacer ${cible}, quelles que soient ses autorisations.` });
      }
    }
  }
  return problemes;
}

// ---------------------------------------------------------------------------
// Analyse d'un dossier sensible (dossier principal et contenu).
// ---------------------------------------------------------------------------
export function analyserArbre({ racine, elements, jeton, noms }) {
  const problemes = [];
  const items = elements.filter((e) => e && e.existe && !e.listeImpossible);
  const principal = items.find((e) => memeChemin(e.chemin, racine));
  const res = { existe: !!principal, conforme: false, aCorriger: [], proprietaires: [], bloquant: false, problemes, exposition: [] };
  if (!principal) return res;
  for (const e of elements) {
    if (e.listeImpossible) { problemes.push({ niveau: "incertain", code: "contenu_illisible", message: `Contenu de ${e.chemin} illisible (${e.listeImpossible}).`, bloquant: true }); }
  }
  for (const e of items) {
    if (e.reparse) problemes.push({ niveau: "incertain", code: "lien_ou_jonction", message: `${e.chemin} est un lien ou une jonction : aucune correction à travers lui.`, bloquant: true });
    if (e.erreur || !e.securite) { problemes.push({ niveau: "incertain", code: "acl_illisible", message: `Autorisations illisibles sur ${e.chemin} (${e.erreur || "inconnu"}).`, bloquant: true }); continue; }
    if (entreesNonPrises(e.securite).length) problemes.push({ niveau: "incertain", code: "entree_inconnue", message: `${e.chemin} contient des entrées d'autorisation non évaluables avec certitude (conditionnelles, objet ou inconnues).`, bloquant: true });
    const refus = liste(e.securite.entrees).filter((x) => x.type === ACE_REFUSER);
    for (const x of refus) {
      const vous = x.sid === jeton.utilisateur || jeton.tous.includes(x.sid) || jeton.actifs.includes(x.sid) || jeton.refus.includes(x.sid);
      problemes.push({ niveau: "incertain", code: "regle_de_refus", bloquant: true, vous,
        message: `Règle de refus ${x.drapeaux & HERITE ? "héritée" : "explicite"} sur ${e.chemin} pour ${nomCompte(x.sid, noms)} (${vous ? "elle vous concerne d'après votre jeton" : "elle ne vous concerne pas d'après votre jeton"}). Correction automatique interrompue par prudence.` });
    }
    for (const x of accesAutres(e.securite, jeton)) res.exposition.push({ chemin: e.chemin, sid: x.sid, masque: droitsReels(x.masque) });
    if (!proprietaireAutorise(e.securite, jeton)) res.proprietaires.push(e.chemin);
  }
  const rp = principal.securite;
  const conformeRacine = racineConforme(rp, jeton);
  const enfants = items.filter((e) => e !== principal);
  const enfantsACorriger = enfants.filter((e) => e.securite && !enfantConforme(e.securite, jeton));
  res.conforme = conformeRacine && enfantsACorriger.length === 0 && res.proprietaires.length === 0;
  res.racineACorriger = !conformeRacine;
  res.aCorriger = enfantsACorriger.map((e) => e.chemin);
  res.bloquant = problemes.some((p) => p.bloquant);
  // Droit de modifier les autorisations (calculé) avant toute écriture.
  if (!res.conforme && !res.bloquant) {
    for (const e of [principal, ...enfants]) {
      const doitModifier = e === principal ? !conformeRacine : res.aCorriger.includes(e.chemin);
      const doitPrendre = res.proprietaires.includes(e.chemin);
      const m = droitsEffectifs(e.securite, jeton);
      if (doitModifier && !(m & DROIT.MODIFICATION_ACL)) { problemes.push({ niveau: "incertain", code: "acl_non_modifiable", bloquant: true, message: `Vous n'avez pas le droit de modifier les autorisations de ${e.chemin}.` }); }
      if (doitPrendre && !(m & DROIT.PRISE_PROPRIETE)) { problemes.push({ niveau: "dangereux", code: "proprietaire_non_modifiable", bloquant: true, message: `${e.chemin} appartient à ${nomCompte(e.securite.proprietaire, noms)} et vous ne pouvez pas en reprendre la propriété.` }); }
    }
    res.bloquant = problemes.some((p) => p.bloquant);
  }
  return res;
}

// Comparaison de deux descripteurs (sans tenir compte de l'ordre des entrées
// ni des indicateurs purement techniques).
function cleEntree(x) { return `${x.type}|${x.sid}|${droitsReels(x.masque)}|${x.drapeaux & 0x1f}`; }
function ensemble(entrees, herite) {
  return liste(entrees).filter((x) => (herite === undefined ? true : !!(x.drapeaux & HERITE) === herite)).map(cleEntree).sort().join(";");
}
export function memesDroits(a, b, { herites = true, proprietaire = true } = {}) {
  if (!a || !b) return false;
  if (proprietaire && a.proprietaire !== b.proprietaire) return false;
  if (!!a.protegee !== !!b.protegee || !!a.nulle !== !!b.nulle) return false;
  if (ensemble(a.entrees, false) !== ensemble(b.entrees, false)) return false;
  if (herites && ensemble(a.entrees, true) !== ensemble(b.entrees, true)) return false;
  return true;
}

// Mêmes droits effectifs, compte par compte : pour chaque SID présent dans l'un
// ou l'autre descripteur (et pour le jeton réel s'il est fourni), les droits
// calculés comme Windows doivent être identiques. Indépendant de l'ordre des
// entrées héritées, que Windows recalcule lors d'une restauration.
const jetonSeul = (sid) => ({ utilisateur: sid, actifs: [], refus: [] });
export function memesDroitsEffectifs(a, b, jeton = null) {
  if (!a || !b) return false;
  const sids = new Set([...liste(a.entrees), ...liste(b.entrees)].map((e) => e.sid).filter(estSid));
  for (const s of [a.proprietaire, b.proprietaire]) if (estSid(s)) sids.add(s);
  for (const sid of sids) if (droitsEffectifs(a, jetonSeul(sid)) !== droitsEffectifs(b, jetonSeul(sid))) return false;
  return !jeton || droitsEffectifs(a, jeton) === droitsEffectifs(b, jeton);
}

// ---------------------------------------------------------------------------
// Application et restauration
// ---------------------------------------------------------------------------
async function appliquer(ps, ops) {
  if (!ops.length) return { ok: true };
  const r = await ps("appliquer", { JG_OPERATIONS: JSON.stringify({ ops }) });
  if (!r.ok) return { ok: false, index: 0, erreur: r.code || "powershell" };
  const resultats = liste(r.resultats);
  const i = resultats.findIndex((x) => !x.ok);
  if (i >= 0) return { ok: false, index: i, erreur: resultats[i].erreur, message: resultats[i].message };
  if (resultats.length !== ops.length) return { ok: false, index: resultats.length, erreur: "incomplet" };
  return { ok: true };
}

export async function inspecter(ps, { arbres = [], chemins = [] }) {
  const r = await ps("inspecter", { JG_ENTREE: JSON.stringify({ arbres, chemins }) });
  if (!r.ok) return r;
  r.arbres = liste(r.arbres).map((a) => ({ ...a, elements: liste(a.elements).map(normaliserElement) }));
  r.chemins = liste(r.chemins).map(normaliserElement);
  r.noms = r.noms || {};
  return r;
}

// Descripteurs décrits par des SDDL (sauvegarde), lus par Windows.
export async function convertirSddl(ps, sddl) {
  const r = await ps("convertir", { JG_ENTREE: JSON.stringify({ sddl }) });
  if (!r.ok) return r;
  const resultats = liste(r.resultats).map((x) => (x.ok ? { ok: true, securite: normaliserElement({ securite: x.securite }).securite } : { ok: false, erreur: x.erreur }));
  if (resultats.length !== sddl.length) return { ok: false, code: "sortie_incomplete" };
  return { ok: true, resultats };
}

// Vérification réelle, par Node lui-même (fs.access ne lit pas les ACL sous
// Windows) : lister chaque dossier, lire chaque fichier ; avec `sonde`, créer
// puis retirer un fichier d'essai dans chaque dossier.
export function verifierAccesReel(elements, { fsImpl = fs, sonde = false } = {}) {
  const echecs = [];
  for (const e of elements.filter((x) => x.existe && !x.reparse)) {
    try {
      if (e.dossier) {
        fsImpl.readdirSync(e.chemin);
        if (sonde) {
          const essai = wpath.join(e.chemin, `.jurgenita-sonde-${randomBytes(4).toString("hex")}${TEMP_SUFFIX}`);
          fsImpl.closeSync(fsImpl.openSync(essai, "wx"));
          try { fsImpl.unlinkSync(essai); } catch { echecs.push({ chemin: essai, code: "sonde_non_retiree" }); }
        }
      } else {
        fsImpl.readFileSync(e.chemin);
      }
    } catch (err) {
      // Disparu entre l'inventaire et le contrôle (autre écriture) : pas un refus d'accès.
      if (err.code !== "ENOENT") echecs.push({ chemin: e.chemin, code: err.code || "erreur" });
    }
  }
  return echecs;
}

// Restauration depuis un instantané (procédure validée) :
// 1. éléments contenus d'abord, du plus profond au moins profond ;
// 2. vérification de ces éléments (propriétaire, héritage, entrées explicites) ;
// 3. dossier principal en dernier ;
// 4. vérification finale complète (entrées héritées comprises).
// Le dossier principal garde l'ACL protégée pendant 1-2 : l'accès de
// l'utilisateur est préservé. Un échec en 1-2 ne restaure PAS le dossier
// principal (« restauration partielle »).
export async function restaurer({ racine, instantane, ps, proprietairesModifies = [], jeton = null }) {
  const journal = [];
  const principal = instantane.find((e) => memeChemin(e.chemin, racine));
  const enfants = instantane.filter((e) => e !== principal).sort((a, b) => profondeur(b.chemin) - profondeur(a.chemin));
  const restaurerElement = async (e) => {
    if (proprietairesModifies.some((p) => memeChemin(p, e.chemin)) && e.securite?.proprietaire) {
      const o = await appliquer(ps, [{ action: "proprietaire", chemin: e.chemin, sid: e.securite.proprietaire }]);
      if (!o.ok) journal.push({ chemin: e.chemin, code: "proprietaire_non_retabli" });
    }
    return appliquer(ps, [{ action: "dacl", chemin: e.chemin, sddl: e.securite.sddl }]);
  };
  for (const e of enfants) {
    const r = await restaurerElement(e);
    if (!r.ok) return { ok: false, etat: "restauration_partielle", etape: "enfants", chemin: e.chemin, journal };
  }
  let lu = await inspecter(ps, { arbres: [racine] });
  if (!lu.ok) return { ok: false, etat: "restauration_partielle", etape: "verification_enfants", journal };
  const actuels = lu.arbres[0].elements;
  for (const e of enfants) {
    const a = actuels.find((x) => memeChemin(x.chemin, e.chemin));
    const proprio = !journal.some((j) => memeChemin(j.chemin, e.chemin));
    if (!a || !memesDroits(a.securite, e.securite, { herites: false, proprietaire: proprio })) return { ok: false, etat: "restauration_partielle", etape: "verification_enfants", chemin: e.chemin, journal };
  }
  if (principal) {
    const r = await restaurerElement(principal);
    if (!r.ok) return { ok: false, etat: "critique", etape: "dossier_principal", journal };
  }
  lu = await inspecter(ps, { arbres: [racine] });
  if (!lu.ok) return { ok: false, etat: "critique", etape: "verification_finale", journal };
  for (const e of instantane) {
    const a = lu.arbres[0].elements.find((x) => memeChemin(x.chemin, e.chemin));
    const proprio = !journal.some((j) => memeChemin(j.chemin, e.chemin));
    if (!a || !memesDroits(a.securite, e.securite, { herites: true, proprietaire: proprio })) return { ok: false, etat: "critique", etape: "verification_finale", chemin: e.chemin, journal };
    // Droits effectifs identiques, quel que soit l'ordre des entrées héritées recalculées par Windows.
    const attendu = proprio ? e.securite : { ...e.securite, proprietaire: a.securite.proprietaire };
    if (!memesDroitsEffectifs(a.securite, attendu, jeton)) return { ok: false, etat: "critique", etape: "verification_droits_effectifs", chemin: e.chemin, journal };
  }
  return { ok: true, etat: "restaure", journal };
}

// Protection d'un arbre : instantané, sauvegarde (facultative), propriétaires,
// remplacement de l'ACL du dossier principal en un seul appel, éléments
// contenus remis en héritage pur, vérification, restauration si échec.
export async function protegerArbre({ racine, elements, jeton, ps, fsImpl = fs, sauvegarder = null, sonde = true }) {
  const instantane = elements.filter((e) => e.existe && e.securite && !e.listeImpossible).map((e) => ({ chemin: e.chemin, dossier: !!e.dossier, securite: e.securite }));
  if (sauvegarder) {
    try { await sauvegarder(instantane); } catch (err) { return { ok: false, etape: "sauvegarde", detail: err?.message }; }
  }
  const analyse = analyserArbre({ racine, elements, jeton });
  const ops = [];
  for (const p of analyse.proprietaires) ops.push({ action: "proprietaire", chemin: p, sid: jeton.utilisateur });
  if (analyse.racineACorriger) ops.push({ action: "dacl", chemin: racine, sddl: sddlCible(jeton.utilisateur) });
  const enfants = [...analyse.aCorriger].sort((a, b) => profondeur(a) - profondeur(b)); // du haut vers le bas
  for (const c of enfants) ops.push({ action: "dacl", chemin: c, sddl: SDDL_HERITAGE_SEUL });
  const app = await appliquer(ps, ops);
  let echec = app.ok ? null : { etape: "application", detail: app.erreur, index: app.index };
  if (!echec) {
    const lu = await inspecter(ps, { arbres: [racine] });
    if (!lu.ok) echec = { etape: "verification", detail: lu.code };
    else {
      const listes = lu.arbres[0].elements.filter((e) => e.listeImpossible);
      const items = lu.arbres[0].elements.filter((e) => e.existe && !e.listeImpossible);
      const principal = items.find((e) => memeChemin(e.chemin, racine));
      if (listes.length) echec = { etape: "verification", detail: "contenu illisible après correction" };
      else if (!principal || !racineConforme(principal.securite, jeton) || !proprietaireAutorise(principal.securite, jeton)) echec = { etape: "verification", detail: "dossier principal non conforme" };
      else {
        const mauvais = items.filter((e) => e !== principal && (!enfantConforme(e.securite, jeton) || !proprietaireAutorise(e.securite, jeton)));
        if (mauvais.length) echec = { etape: "verification", detail: `${mauvais.length} élément(s) non conforme(s)` };
        else {
          const acces = verifierAccesReel(items, { fsImpl, sonde }).filter((x) => x.code !== "sonde_non_retiree");
          if (acces.length) echec = { etape: "verification", detail: `accès réel refusé (${acces[0].code})` };
        }
      }
    }
  }
  if (!echec) return { ok: true, corrections: ops.length, instantane };
  const proprietairesModifies = app.ok ? analyse.proprietaires : analyse.proprietaires.slice(0, Math.min(app.index, analyse.proprietaires.length));
  const restauration = await restaurer({ racine, instantane, ps, proprietairesModifies, jeton });
  return { ok: false, ...echec, restauration, instantane };
}

// ---------------------------------------------------------------------------
// Diagnostic en fin de reprise (2b.3) : refus permanent ou verrou passager ?
// ---------------------------------------------------------------------------
export async function diagnostiquerAcces(fichier, { ps = executerPowerShell, whoami = executerWhoami } = {}) {
  const [r, u, g] = await Promise.all([ps("diagnostiquer", { JG_ENTREE: JSON.stringify({ fichier }) }), whoami(["/user", "/fo", "csv", "/nh"]), whoami(["/groups", "/fo", "csv", "/nh"])]);
  if (!r?.ok) return "incertain";
  const jeton = construireJeton(r.jeton, u, g);
  if (!jeton.certain) return "incertain";
  normaliserElement(r.fichier);
  normaliserElement(r.dossier);
  if (r.ouverture === "occupe") return "verrou";
  const mDossier = droitsEffectifs(r.dossier?.securite, jeton);
  const mFichier = r.fichier?.existe ? droitsEffectifs(r.fichier.securite, jeton) : null;
  // Écriture atomique : créer un temporaire dans le dossier, puis remplacer le fichier.
  const permis = !!(mDossier & DROIT.AJOUT_FICHIER) && (mFichier === null || ((mFichier & DROIT.LECTURE_DONNEES) && ((mFichier & DROIT.SUPPRESSION) || (mDossier & DROIT.SUPPRESSION_CONTENU))));
  if (r.ouverture === "refuse") return permis ? "incertain" : "refuse";
  if (r.ouverture === "ok" || r.ouverture === "absent") return permis ? "verrou" : "refuse";
  return "incertain";
}
