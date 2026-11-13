// Les marques (clients) gérées par Jurgenita et la configuration de leurs
// connexions. Les jetons sont gardés dans data/secrets/brands/, hors de Git.
// Pour la première marque, les variables du .env servent de valeurs par défaut.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import {
  readJsonFile, readJsonFileRetrying, writeJsonAtomicAsync, removeFileAsync, withFileLock, leftoverTemps, describeUnreadable,
  FileBusyError, ReadOnlyFileError,
} from "./atomic-file.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = path.join(process.env.JURGENITA_SECRETS_DIR || path.join(here, "..", "data", "secrets"), "brands");

export const list = () => store.read("brands");
export const defaultId = () => list()[0]?.id;

export function get(id) {
  const brand = list().find((b) => b.id === id);
  if (!brand) throw Object.assign(new Error("Marque inconnue"), { status: 404 });
  return brand;
}

export function create({ nom, couleur }) {
  if (!nom?.trim()) throw Object.assign(new Error("Donnez un nom à la marque"), { status: 400 });
  const base = nom.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "marque";
  const brands = list();
  let id = base;
  // Un identifiant dont le fichier d'accès existe encore (orphelin laissé par
  // une ancienne version) n'est jamais réutilisé : la nouvelle marque
  // n'hérite pas d'anciens accès, et l'orphelin n'est ni modifié ni supprimé.
  for (let i = 2; brands.some((b) => b.id === id) || fs.existsSync(secretFile(id)); i++) id = `${base}-${i}`;
  const brand = { id, nom: nom.trim(), couleur: couleur || "#4fd8ff" };
  store.write("brands", [...brands, brand]);
  const template = store.read("profile", defaultId());
  store.write("profile", {
    prenom: template.prenom,
    appellation: template.appellation,
    marque: brand.nom,
    activite: "",
    niche: "",
    ton_de_marque: "",
    plateformes: ["Instagram", "Facebook"],
    objectifs: [],
    regles: [],
    concurrents: [],
    mots_cles_veille: [brand.nom],
    site_web: "",
    heure_reveil: template.heure_reveil,
  }, id);
  return brand;
}

// Suppression d'une marque. Elle passe par la file d'attente du fichier
// d'accès : les enregistrements déjà en attente se terminent d'abord, ceux qui
// arrivent après échouent en 404 sans rien recréer. Les accès sont effacés
// AVANT de retirer la marque de la liste : si l'effacement échoue (verrou,
// lecture seule), la marque reste en place avec ses accès, sans orphelin.
// Une seule suppression à la fois, pour garder toujours au moins une marque.
export async function remove(id) {
  await withFileLock(REMOVALS_QUEUE, () => updateSecrets(id, async () => {
    if (list().length <= 1) throw Object.assign(new Error("Gardez au moins une marque"), { status: 400 });
    get(id);
    try {
      await removeFileAsync(secretFile(id));
    } catch (err) {
      if (err instanceof FileBusyError) {
        console.warn(`[accès] Suppression de la marque ${id} reportée : fichier de ses accès verrouillé. Rien n'a été supprimé.`);
        throw new FileBusyError(secretFile(id), `La marque « ${id} » n'a pas été supprimée : le fichier de ses accès est momentanément verrouillé (antivirus, synchronisation OneDrive, sauvegarde…). La marque est conservée, ainsi que ses accès : réessayez dans quelques secondes.`);
      }
      if (err instanceof ReadOnlyFileError) {
        throw new ReadOnlyFileError(secretFile(id), `La marque « ${id} » n'a pas été supprimée : le fichier de ses accès est en lecture seule. Retirez sa protection en écriture, puis réessayez.`);
      }
      throw err;
    }
    // Liste relue maintenant : une marque créée pendant l'attente n'est pas perdue.
    store.write("brands", list().filter((b) => b.id !== id));
    // Suppression finalisée : plus rien à masquer ni à signaler pour cette marque.
    redactionCache.delete(id);
    reported.delete(id);
    reported.delete(`verrou:${id}`);
  }));
}

const secretFile = (id) => path.join(SECRETS_DIR, `${store.checkBrandId(id)}.json`);
// Clé de file d'attente (aucun fichier n'est créé à cet emplacement).
const REMOVALS_QUEUE = path.join(SECRETS_DIR, ".suppressions-de-marques");

// Accès enregistrés d'une marque qui existent mais ne peuvent pas être lus
// (fichier abîmé, tronqué, inaccessible). Ils ne sont jamais écrasés.
export class UnreadableSecretsError extends Error {
  constructor(id) {
    super(`Les accès enregistrés de la marque « ${id} » sont illisibles. Ils ne seront pas écrasés : restaurez le fichier data/secrets/brands/${id}.json ou retirez-le vous-même avant de les ressaisir.`);
    this.name = "UnreadableSecretsError";
    this.status = 409;
  }
}

// Marques dont le fichier illisible a déjà été signalé : un seul message par
// incident, noté AVANT d'écrire, car le masquage des journaux relit lui-même
// les accès des marques (sinon : boucle infinie).
const reported = new Set();

// Cache réservé au MASQUAGE DES JOURNAUX (sous-étape 2b.3) : pour chaque
// marque, les seules valeurs à masquer (jetons Meta, TikTok, LinkedIn), issues
// de la dernière lecture valide. Il permet de masquer ces jetons même quand le
// fichier est momentanément verrouillé ou illisible. Il ne sert JAMAIS à
// configurer un connecteur, à authentifier quoi que ce soit, ni à réécrire un
// fichier, et il n'est jamais renvoyé par une réponse.
const redactionCache = new Map();
const REDACTED_FIELDS = ["meta_token", "tiktok_token", "linkedin_token"];

// Mis à jour uniquement après une lecture valide : fichier lu (on remplace)
// ou absent (plus aucune valeur). Un fichier verrouillé ou illisible le laisse tel quel.
function refreshRedactionCache(id, result) {
  if (result.etat === "ok") {
    redactionCache.set(id, REDACTED_FIELDS.map((f) => result.valeur[f]).filter((v) => typeof v === "string" && v));
  } else if (result.etat === "absent") {
    redactionCache.delete(id);
  }
}

// Valeurs à masquer pour toutes les marques : lecture fraîche si possible,
// sinon les dernières valeurs valides connues. Uniquement pour redact.js.
export function secretsForRedaction() {
  return list().flatMap((b) => {
    refreshRedactionCache(b.id, readJsonFile(secretFile(b.id)));
    return redactionCache.get(b.id) || [];
  });
}

const isLocked = (result) => result.etat === "illisible" && result.erreur.diagnostic?.categorie === "verrouille";

// { etat: "absent" | "ok" | "illisible" | "verrouille", valeurs }
// « verrouille » : fichier probablement valide mais momentanément inaccessible
// (antivirus, OneDrive…) ; ce n'est PAS un fichier abîmé.
function secretsState(id) {
  const result = readJsonFile(secretFile(id));
  refreshRedactionCache(id, result);
  if (isLocked(result)) {
    if (!reported.has(`verrou:${id}`)) {
      reported.add(`verrou:${id}`);
      console.warn(`[accès] Accès de la marque ${id} momentanément inaccessibles : ${describeUnreadable(result.erreur)}. Les connexions de cette marque reprendront dès la libération du fichier.`);
    }
    return { etat: "verrouille", valeurs: {} };
  }
  reported.delete(`verrou:${id}`);
  if (result.etat === "illisible") {
    if (!reported.has(id)) {
      reported.add(id);
      // Jamais le message brut de l'erreur : seulement un diagnostic sans contenu.
      console.error(`[accès] ${result.erreur.message} (marque ${id}) : ${describeUnreadable(result.erreur)}`);
    }
    return { etat: "illisible", valeurs: {} };
  }
  reported.delete(id);
  return { etat: result.etat, valeurs: result.etat === "ok" ? result.valeur : {} };
}

// Lecture pour usage : un fichier illisible donne des accès vides (la marque
// fonctionne alors sans ses connexions, comme avant), mais il est signalé.
function readSecrets(id) {
  return secretsState(id).valeurs;
}

// Messages des erreurs de stockage, propres à une marque, sans chemin ni contenu.
const busyError = (id) => new FileBusyError(secretFile(id), `Les accès de la marque « ${id} » sont momentanément verrouillés (antivirus, synchronisation OneDrive, sauvegarde…). Rien n'a été modifié : réessayez dans quelques secondes.`);
const readOnlyError = (id) => new ReadOnlyFileError(secretFile(id), `Le fichier des accès de la marque « ${id} » est en lecture seule. Jurgenita ne le modifiera pas : retirez sa protection en écriture, puis réessayez.`);

// Lecture avant modification (dans la file d'attente du fichier) : patiente
// pendant un verrou passager, refuse un fichier réellement illisible (409).
async function readSecretsForUpdate(id) {
  let result;
  try {
    result = await readJsonFileRetrying(secretFile(id));
  } catch (err) {
    if (err instanceof FileBusyError) throw busyError(id);
    throw err;
  }
  if (result.etat === "illisible") {
    secretsState(id); // signalement unique, sans contenu
    throw new UnreadableSecretsError(id);
  }
  refreshRedactionCache(id, result);
  return result.etat === "ok" ? result.valeur : {};
}

async function writeSecrets(id, value) {
  try {
    await writeJsonAtomicAsync(secretFile(id), value, { mode: 0o600 });
  } catch (err) {
    if (err instanceof FileBusyError) {
      console.warn(`[accès] Enregistrement des accès de la marque ${id} reporté : fichier verrouillé. Rien n'a été modifié.`);
      throw busyError(id);
    }
    if (err instanceof ReadOnlyFileError) throw readOnlyError(id);
    throw err;
  }
}

// Lecture, modification et écriture des accès d'une marque, sans qu'une autre
// opération sur le même fichier ne s'intercale (aucune mise à jour perdue).
const updateSecrets = (id, fn) => withFileLock(secretFile(id), fn);

// État de stockage des accès, pour l'interface et les diagnostics.
export function secretsHealth() {
  return {
    illisibles: list().filter((b) => secretsState(b.id).etat === "illisible").map((b) => b.id),
    fichiers_temporaires: leftoverTemps(SECRETS_DIR).length,
  };
}

// Configuration complète des connexions d'une marque.
export function config(id) {
  const env = id === defaultId() ? process.env : {};
  const s = readSecrets(id);
  return {
    meta: {
      token: s.meta_token || env.META_ACCESS_TOKEN || "",
      igUserId: s.meta_ig_user_id || env.META_IG_USER_ID || "",
      pageId: s.meta_page_id || env.META_PAGE_ID || "",
      adAccountId: (s.meta_ad_account_id || env.META_AD_ACCOUNT_ID || "").replace(/^act_/, ""),
    },
    googleBusinessLocation: s.google_business_location || env.GOOGLE_BUSINESS_LOCATION || "",
    tiktok: { token: s.tiktok_token || env.TIKTOK_ACCESS_TOKEN || "" },
    linkedin: { token: s.linkedin_token || env.LINKEDIN_ACCESS_TOKEN || "", orgId: s.linkedin_org_id || env.LINKEDIN_ORG_ID || "" },
  };
}

// Champs modifiables depuis l'interface. Une valeur vide ne remplace pas
// celle déjà enregistrée, pour ne pas effacer un jeton par erreur.
export const CONFIG_FIELDS = [
  "meta_token", "meta_ig_user_id", "meta_page_id", "meta_ad_account_id",
  "google_business_location", "tiktok_token", "linkedin_token", "linkedin_org_id",
];

export async function saveConfig(id, values) {
  get(id);
  await updateSecrets(id, async () => {
    get(id); // revérifiée dans la file : la marque a pu être supprimée entre-temps (404, rien n'est écrit)
    const current = await readSecretsForUpdate(id);
    for (const field of CONFIG_FIELDS) {
      if (typeof values[field] === "string" && values[field].trim()) current[field] = values[field].trim();
    }
    for (const field of values.effacer || []) {
      if (CONFIG_FIELDS.includes(field)) delete current[field];
    }
    await writeSecrets(id, current);
  });
}

// État des connexions, sans jamais renvoyer un jeton.
export function connectionStatus(id) {
  const c = config(id);
  const state = secretsState(id);
  return {
    acces_illisibles: state.etat === "illisible",
    meta: Boolean(c.meta.token && (c.meta.igUserId || c.meta.pageId)),
    meta_ads: Boolean(c.meta.token && c.meta.adAccountId),
    google_business: Boolean(c.googleBusinessLocation),
    tiktok: Boolean(c.tiktok.token),
    linkedin: Boolean(c.linkedin.token && c.linkedin.orgId),
    champs_renseignes: CONFIG_FIELDS.filter((f) => state.valeurs[f]),
  };
}

// Lien de validation donné au client : un jeton secret par marque.
export async function validationToken(id) {
  get(id);
  return updateSecrets(id, async () => {
    get(id); // revérifiée dans la file : la marque a pu être supprimée entre-temps (404, rien n'est écrit)
    const s = await readSecretsForUpdate(id);
    if (!s.validation_token) {
      s.validation_token = randomBytes(18).toString("base64url");
      await writeSecrets(id, s);
    }
    return s.validation_token;
  });
}

export function brandByValidationToken(token) {
  if (!token || token.length < 20) return null;
  return list().find((b) => readSecrets(b.id).validation_token === token) || null;
}
