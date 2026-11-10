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
    case "lecture_impossible": return `lecture impossible (${d.code || "erreur inconnue"})`;
    default: return "raison inconnue";
  }
}

// { etat: "absent" } | { etat: "ok", valeur } | { etat: "illisible", erreur }
export function readJsonFile(file, { fsImpl = fs } = {}) {
  let text;
  try {
    text = fsImpl.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { etat: "absent" };
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
