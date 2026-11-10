// Les marques (clients) gérées par Jurgenita et la configuration de leurs
// connexions. Les jetons sont gardés dans data/secrets/brands/, hors de Git.
// Pour la première marque, les variables du .env servent de valeurs par défaut.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import { readJsonFile, writeJsonAtomic, leftoverTemps, describeUnreadable } from "./atomic-file.js";

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
  for (let i = 2; brands.some((b) => b.id === id); i++) id = `${base}-${i}`;
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

export function remove(id) {
  const brands = list();
  if (brands.length <= 1) throw Object.assign(new Error("Gardez au moins une marque"), { status: 400 });
  get(id);
  store.write("brands", brands.filter((b) => b.id !== id));
  fs.rmSync(secretFile(id), { force: true });
}

const secretFile = (id) => path.join(SECRETS_DIR, `${store.checkBrandId(id)}.json`);

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

// { etat: "absent" | "ok" | "illisible", valeurs }
function secretsState(id) {
  const result = readJsonFile(secretFile(id));
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

// Lecture avant modification : refuse si le fichier existe mais est illisible.
function readSecretsForUpdate(id) {
  const state = secretsState(id);
  if (state.etat === "illisible") throw new UnreadableSecretsError(id);
  return state.valeurs;
}

function writeSecrets(id, value) {
  writeJsonAtomic(secretFile(id), value, { mode: 0o600 });
}

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

export function saveConfig(id, values) {
  get(id);
  const current = readSecretsForUpdate(id);
  for (const field of CONFIG_FIELDS) {
    if (typeof values[field] === "string" && values[field].trim()) current[field] = values[field].trim();
  }
  for (const field of values.effacer || []) {
    if (CONFIG_FIELDS.includes(field)) delete current[field];
  }
  writeSecrets(id, current);
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
export function validationToken(id) {
  get(id);
  const s = readSecretsForUpdate(id);
  if (!s.validation_token) {
    s.validation_token = randomBytes(18).toString("base64url");
    writeSecrets(id, s);
  }
  return s.validation_token;
}

export function brandByValidationToken(token) {
  if (!token || token.length < 20) return null;
  return list().find((b) => readSecrets(b.id).validation_token === token) || null;
}
