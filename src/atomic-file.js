// Lecture prudente et écriture atomique de fichiers JSON.
//
// Lecture : distingue un fichier ABSENT (normal) d'un fichier ILLISIBLE
// (corrompu, tronqué, inaccessible), pour que l'appelant ne confonde jamais
// « rien d'enregistré » avec « contenu perdu » et n'écrase pas ce qu'il ne
// sait pas lire.
//
// Écriture : le fichier cible contient toujours soit l'ancienne version
// complète, soit la nouvelle, même après une coupure de courant ou un arrêt
// forcé :
//   1. écriture dans un fichier temporaire du même dossier ;
//   2. vidage sur le disque (fsync) ;
//   3. relecture et comparaison avec le contenu attendu ;
//   4. remplacement du fichier cible en une seule opération (rename) ;
//   5. vidage du dossier sur le disque (hors Windows, où ce n'est pas possible).
// En cas d'échec avant l'étape 4, le fichier cible n'est pas touché et le
// fichier temporaire est retiré.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const TEMP_SUFFIX = ".tmp-jurgenita";

// Codes qu'un verrou passager produit sous Windows (antivirus, OneDrive,
// sauvegarde, éditeur qui garde le fichier ouvert).
const LOCK_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

// Sous Linux et macOS, EACCES n'est jamais un verrou : c'est un refus des
// droits du système (propriétaire, permissions), permanent tant que personne
// ne les change. Il est signalé tout de suite, sans attendre (sous-étape 2b.4).
// Sous Windows, EACCES et EPERM restent ambigus (verrou ou refus) : les
// reprises de la 2b.3 s'appliquent, puis un diagnostic tranche.
const isPosixDenial = (err, platform) => err?.code === "EACCES" && platform !== "win32";

// Accès refusé de façon permanente par les droits du système.
export class AccessDeniedError extends Error {
  constructor(file, message = "Accès refusé : Jurgenita n'a pas les droits nécessaires sur ce fichier ou ce dossier (propriétaire ou permissions). Voir Profil → Connexions.") {
    super(message);
    this.name = "AccessDeniedError";
    this.status = 409;
    this.file = file;
  }
}

// Fichier illisible. L'erreur ne garde QUE des informations sans contenu
// (catégorie, code système, position, taille) : le message brut d'une erreur
// de lecture JSON recopie un extrait du fichier, donc parfois d'un secret.
// L'erreur d'origine n'est volontairement pas conservée (pas de « cause »),
// pour qu'aucun affichage complet de l'erreur ne puisse la révéler.
export class UnreadableFileError extends Error {
  constructor(file, diagnostic) {
    super(`Fichier illisible : ${path.basename(file)}`);
    this.name = "UnreadableFileError";
    this.file = file;
    this.diagnostic = diagnostic;
  }
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "tableau" : typeof v);

// Diagnostic d'une erreur JSON : on n'en garde que les nombres.
function jsonDiagnostic(err, text) {
  const position = /position (\d+)/.exec(err.message)?.[1];
  const lineCol = /line (\d+) column (\d+)/.exec(err.message);
  return {
    categorie: text.trim() === "" ? "fichier_vide" : "json_invalide",
    ...(position !== undefined && { position: Number(position) }),
    ...(lineCol && { ligne: Number(lineCol[1]), colonne: Number(lineCol[2]) }),
    taille: Buffer.byteLength(text),
  };
}

// Phrase de diagnostic pour le journal, sans aucun contenu du fichier.
export function describeUnreadable(erreur) {
  const d = erreur?.diagnostic || {};
  const size = d.taille !== undefined ? `, ${d.taille} octets` : "";
  switch (d.categorie) {
    case "fichier_vide": return `fichier vide${size}`;
    case "json_invalide": return `JSON invalide${d.position !== undefined ? `, position ${d.position}` : ""}${d.ligne ? ` (ligne ${d.ligne}, colonne ${d.colonne})` : ""}${size}`;
    case "pas_un_objet": return `le contenu n'est pas un objet JSON (${d.type})${size}`;
    case "verrouille": return `fichier verrouillé ou accès refusé (${d.code})`;
    case "acces_refuse": return `accès refusé par les droits du système (${d.code})`;
    case "lecture_impossible": return `lecture impossible (${d.code || "erreur inconnue"})`;
    default: return "raison inconnue";
  }
}

// { etat: "absent" } | { etat: "ok", valeur } | { etat: "illisible", erreur }
export function readJsonFile(file, { fsImpl = fs, platform = process.platform } = {}) {
  let text;
  try {
    text = fsImpl.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { etat: "absent" };
    // Refus permanent des droits (Linux, macOS) : pas un verrou, pas un fichier abîmé.
    if (isPosixDenial(err, platform)) return { etat: "illisible", erreur: new UnreadableFileError(file, { categorie: "acces_refuse", code: String(err.code) }) };
    // Verrouillé : le contenu n'est pas en cause, il faut seulement réessayer.
    if (LOCK_CODES.has(err.code)) return { etat: "illisible", erreur: new UnreadableFileError(file, { categorie: "verrouille", code: String(err.code) }) };
    return { etat: "illisible", erreur: new UnreadableFileError(file, { categorie: "lecture_impossible", code: String(err.code || "") }) };
  }
  let valeur;
  try {
    valeur = JSON.parse(text);
  } catch (err) {
    return { etat: "illisible", erreur: new UnreadableFileError(file, jsonDiagnostic(err, text)) };
  }
  if (valeur === null || typeof valeur !== "object" || Array.isArray(valeur)) {
    return { etat: "illisible", erreur: new UnreadableFileError(file, { categorie: "pas_un_objet", type: typeOf(valeur), taille: Buffer.byteLength(text) }) };
  }
  return { etat: "ok", valeur };
}

// Sous Windows, un antivirus ou l'indexation peut verrouiller brièvement un
// fichier : on réessaie le remplacement quelques fois avant d'abandonner.
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeJsonAtomic(file, value, { mode = 0o600, fsImpl = fs, retries = 5 } = {}) {
  const dir = path.dirname(file);
  const text = JSON.stringify(value, null, 2);
  const expected = JSON.stringify(JSON.parse(text));
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}${TEMP_SUFFIX}`);
  fsImpl.mkdirSync(dir, { recursive: true });
  try {
    const fd = fsImpl.openSync(temp, "wx", mode);
    try {
      fsImpl.writeFileSync(fd, text, "utf8");
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
    const check = readJsonFile(temp, { fsImpl });
    if (check.etat !== "ok" || JSON.stringify(check.valeur) !== expected) {
      throw new Error(`Vérification de l'écriture échouée : ${path.basename(file)} n'a pas été modifié`);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fsImpl.renameSync(temp, file);
        break;
      } catch (err) {
        if (!RETRYABLE.has(err.code) || attempt >= retries) throw err;
        sleepSync(50 * (attempt + 1));
      }
    }
  } catch (err) {
    try { fsImpl.rmSync(temp, { force: true }); } catch { /* le fichier temporaire sera signalé plus tard */ }
    throw err;
  }
  syncDirectory(dir, fsImpl);
}

// Rend le remplacement durable après une coupure de courant (POSIX). Windows
// ne permet pas d'ouvrir un dossier ainsi ; NTFS journalise le renommage.
function syncDirectory(dir, fsImpl) {
  if (process.platform === "win32") return;
  let fd;
  try {
    fd = fsImpl.openSync(dir, "r");
    fsImpl.fsyncSync(fd);
  } catch {
    // Certains systèmes de fichiers refusent : le renommage reste atomique.
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
}

// Fichiers temporaires laissés par une écriture interrompue (arrêt forcé) :
// ils ne font jamais foi et sont ignorés à la lecture. Ils ne sont pas
// supprimés automatiquement à cette étape ; on se contente de les signaler.
export function leftoverTemps(dir, { fsImpl = fs } = {}) {
  try {
    return fsImpl.readdirSync(dir).filter((name) => name.endsWith(TEMP_SUFFIX));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Écriture asynchrone (sous-étape 2b.3)
//
// Mêmes garanties que writeJsonAtomic (temporaire, fsync, relecture,
// remplacement en une opération, vidage du dossier), mais :
// - aucune attente ne bloque le serveur : les autres requêtes sont servies ;
// - un verrou passager est réessayé à chaque étape sensible, avec des attentes
//   progressives (25 ms, doublées jusqu'à 1 s, part aléatoire) pendant au plus
//   `budgetMs` (5 s par défaut), puis FileBusyError (503, « réessayez ») ;
// - un fichier en lecture seule est refusé tout de suite (ReadOnlyFileError,
//   409) : il n'est ni remplacé ni rendu modifiable, sous Linux comme Windows ;
// - les fichiers temporaires d'écritures antérieures ne sont jamais supprimés :
//   une écriture qui échoue ne retire que son propre temporaire.
// La lecture-modification-écriture d'un même fichier doit se faire dans
// withFileLock, qui les exécute l'une après l'autre (pas de mise à jour perdue).
// ---------------------------------------------------------------------------

export const DEFAULT_BUDGET_MS = 5000;

// Verrou qui n'a pas cédé dans le temps imparti. Message sans chemin ni contenu.
export class FileBusyError extends Error {
  constructor(file, message = "Fichier momentanément verrouillé (antivirus, synchronisation OneDrive, sauvegarde…). Réessayez dans quelques secondes.") {
    super(message);
    this.name = "FileBusyError";
    this.status = 503;
    this.retryAfter = 5;
    this.file = file;
  }
}

// Fichier protégé en écriture par son propriétaire : on ne le modifie pas.
export class ReadOnlyFileError extends Error {
  constructor(file, message = "Fichier en lecture seule : Jurgenita ne le modifiera pas. Retirez la protection en écriture, puis réessayez.") {
    super(message);
    this.name = "ReadOnlyFileError";
    this.status = 409;
    this.file = file;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exécute `op`, en réessayant tant qu'elle échoue sur un verrou et que le
// délai n'est pas écoulé. `onLock` peut transformer l'erreur (lecture seule).
async function retrying(op, { deadline, sleep, file, onLock, platform = process.platform }) {
  for (let delay = 25; ; delay = Math.min(delay * 2, 1000)) {
    try {
      return await op();
    } catch (err) {
      if (isPosixDenial(err, platform)) throw new AccessDeniedError(file);
      if (!LOCK_CODES.has(err?.code)) throw err;
      if (onLock) await onLock(err);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new FileBusyError(file);
      await sleep(Math.min(remaining, delay * (0.5 + Math.random() / 2)));
    }
  }
}

// Lecture seule : aucun droit d'écriture (ni propriétaire, ni groupe, ni autres).
// Sous Windows, Node présente l'attribut « lecture seule » de la même façon.
async function isReadOnly(file, fsImpl) {
  try {
    return ((await fsImpl.promises.stat(file)).mode & 0o222) === 0;
  } catch {
    return false; // absent ou inaccessible : ce n'est pas une lecture seule
  }
}

export async function writeJsonAtomicAsync(file, value, { mode = 0o600, dirMode, fsImpl = fs, budgetMs = DEFAULT_BUDGET_MS, sleep = defaultSleep, platform = process.platform } = {}) {
  const fsp = fsImpl.promises;
  const dir = path.dirname(file);
  const text = JSON.stringify(value, null, 2);
  const expected = JSON.stringify(JSON.parse(text));
  const deadline = Date.now() + budgetMs;
  const opts = { deadline, sleep, file, platform };
  // Refus immédiat, avant toute écriture, d'un fichier en lecture seule.
  if (await isReadOnly(file, fsImpl)) throw new ReadOnlyFileError(file);
  // dirMode : droits des dossiers créés ici (700 pour les secrets, 2b.4).
  try {
    await fsp.mkdir(dir, dirMode === undefined ? { recursive: true } : { recursive: true, mode: dirMode });
  } catch (err) {
    if (isPosixDenial(err, platform)) throw new AccessDeniedError(file);
    throw err;
  }
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}${TEMP_SUFFIX}`);
  let created = false;
  try {
    const handle = await retrying(() => fsp.open(temp, "wx", mode), opts);
    created = true;
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const check = await retrying(() => {
      const r = readJsonFile(temp, { fsImpl, platform });
      if (r.etat === "illisible" && r.erreur.diagnostic.categorie === "acces_refuse") throw new AccessDeniedError(file);
      if (r.etat === "illisible" && r.erreur.diagnostic.categorie === "verrouille") throw Object.assign(new Error("relecture verrouillée"), { code: r.erreur.diagnostic.code });
      return r;
    }, opts);
    if (check.etat !== "ok" || JSON.stringify(check.valeur) !== expected) {
      throw new Error(`Vérification de l'écriture échouée : ${path.basename(file)} n'a pas été modifié`);
    }
    // Remplacement. Un refus peut venir d'un verrou (on réessaie) ou d'un
    // fichier passé en lecture seule entre-temps (refus immédiat).
    await retrying(() => fsp.rename(temp, file), {
      ...opts,
      onLock: async () => { if (await isReadOnly(file, fsImpl)) throw new ReadOnlyFileError(file); },
    });
    created = false;
  } catch (err) {
    if (created) await removeOwnTemp(temp, fsImpl, deadline, sleep);
    if (isPosixDenial(err, platform)) throw new AccessDeniedError(file);
    // Un verrou qui s'échappe d'une étape non réessayée reste un verrou.
    if (LOCK_CODES.has(err?.code)) throw new FileBusyError(file);
    throw err;
  }
  await syncDirectoryAsync(dir, fsImpl);
}

// Retire le temporaire de CETTE écriture, en réessayant un peu sous verrou ;
// s'il résiste, il est laissé (et signalé par leftoverTemps), jamais relu.
async function removeOwnTemp(temp, fsImpl, deadline, sleep) {
  try {
    await retrying(() => fsImpl.promises.rm(temp, { force: true }), { deadline: Math.max(deadline, Date.now() + 1000), sleep, file: temp });
  } catch {
    // laissé sur place : signalé au démarrage, nettoyage réservé à la 2b.5
  }
}

async function syncDirectoryAsync(dir, fsImpl) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await fsImpl.promises.open(dir, "r");
    await handle.sync();
  } catch {
    // Certains systèmes de fichiers refusent : le renommage reste atomique.
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// Effacement d'un fichier, avec les mêmes règles que l'écriture : un verrou
// passager est réessayé (FileBusyError au-delà du délai), un fichier en lecture
// seule est refusé tout de suite (ReadOnlyFileError) et n'est pas touché. Un
// fichier déjà absent n'est pas une erreur.
export async function removeFileAsync(file, { fsImpl = fs, budgetMs = DEFAULT_BUDGET_MS, sleep = defaultSleep, platform = process.platform } = {}) {
  if (await isReadOnly(file, fsImpl)) throw new ReadOnlyFileError(file);
  try {
    await retrying(() => fsImpl.promises.unlink(file), {
      deadline: Date.now() + budgetMs, sleep, file, platform,
      onLock: async () => { if (await isReadOnly(file, fsImpl)) throw new ReadOnlyFileError(file); },
    });
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  await syncDirectoryAsync(path.dirname(file), fsImpl);
}

// Lecture qui patiente pendant un verrou passager. Un fichier réellement
// abîmé est renvoyé tout de suite comme « illisible » ; un verrou qui ne
// cède pas dans le délai donne FileBusyError.
export async function readJsonFileRetrying(file, { fsImpl = fs, budgetMs = DEFAULT_BUDGET_MS, sleep = defaultSleep, platform = process.platform } = {}) {
  return retrying(() => {
    const r = readJsonFile(file, { fsImpl, platform });
    if (r.etat === "illisible" && r.erreur.diagnostic.categorie === "acces_refuse") throw new AccessDeniedError(file);
    if (r.etat === "illisible" && r.erreur.diagnostic.categorie === "verrouille") throw Object.assign(new Error("lecture verrouillée"), { code: r.erreur.diagnostic.code });
    return r;
  }, { deadline: Date.now() + budgetMs, sleep, file, platform });
}

// File d'attente par fichier (dans ce processus) : les opérations sur un même
// fichier s'exécutent l'une après l'autre, dans l'ordre d'arrivée ; celles sur
// des fichiers différents ne s'attendent pas. Un échec ne bloque pas la suite.
const queues = new Map();
const queueKey = (file) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file));

export function withFileLock(file, fn) {
  const key = queueKey(file);
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.then(() => fn());
  const settled = run.then(() => {}, () => {});
  queues.set(key, settled);
  settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return run;
}
