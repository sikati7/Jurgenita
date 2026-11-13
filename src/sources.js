// Sources de données : les vrais comptes quand ils sont connectés, sinon les
// données de démo de data/. Une source qui échoue retombe sur la démo.
// La boîte mail et l'agenda sont les vôtres ; le reste est propre à chaque marque.
import * as store from "./store.js";
import * as brands from "./brands.js";
import * as google from "./connectors/google.js";
import * as meta from "./connectors/meta.js";
import * as tiktok from "./connectors/tiktok.js";
import * as linkedin from "./connectors/linkedin.js";
import * as redaction from "./redact.js";
import { readJsonFile, describeUnreadable } from "./atomic-file.js";
import { safeMessage } from "./safe-error.js";
import { googleTokenFile } from "./secret-dir.js";

async function tryLive(name, live, fallback) {
  try {
    return await live();
  } catch (err) {
    console.error(`[${name}] repli sur la démo : ${safeMessage(err)}`);
    return fallback();
  }
}

// État du jeton Google, lu prudemment ICI plutôt que par google.js (qui le lit
// sans protection) : un jeton vide, tronqué ou invalide ne doit ni arrêter le
// serveur, ni apparaître dans un journal. Il est alors considéré comme « à
// reconnecter » ; le fichier n'est jamais modifié ni supprimé ici.
// Même emplacement que dans google.js.
const TOKEN_FILE = googleTokenFile(); // chemin centralisé (2b.4)

let reportedProblem = null; // pour ne signaler un même problème qu'une fois

function readGoogleToken() {
  const result = readJsonFile(TOKEN_FILE);
  if (result.etat === "absent") return { etat: "absent" };
  let probleme = null;
  if (result.etat === "illisible") probleme = describeUnreadable(result.erreur);
  else if (typeof result.valeur.refresh_token !== "string" || !result.valeur.refresh_token.trim()) probleme = "jeton de renouvellement absent ou vide";
  if (!probleme) {
    reportedProblem = null;
    const scope = typeof result.valeur.scope === "string" ? result.valeur.scope : "";
    return { etat: "ok", scope };
  }
  if (probleme !== reportedProblem) {
    reportedProblem = probleme;
    console.warn(`[google] Jeton Google illisible (${probleme}) : connexion Google suspendue, reconnectez Google depuis Profil → Connexions.`);
  }
  return { etat: "illisible" };
}

// Le jeton, s'il est lisible, est aussi masqué dans tous les journaux.
redaction.addSecretSource(() => {
  const token = readJsonFile(TOKEN_FILE);
  return token.etat === "ok" && typeof token.valeur.refresh_token === "string" ? [token.valeur.refresh_token] : [];
});

export function googleState() {
  const configure = google.configured();
  const token = configure ? readGoogleToken() : { etat: "absent" };
  const connecte = token.etat === "ok";
  return {
    configure,
    connecte,
    avis_autorises: connecte && token.scope.includes("business.manage"),
    reconnexion: token.etat === "illisible",
  };
}

export const inbox = () => (googleState().connecte ? tryLive("gmail", () => google.inbox(), () => store.read("inbox")) : store.read("inbox"));
export const agenda = () => (googleState().connecte ? tryLive("agenda", () => google.agenda(), () => store.read("agenda")) : store.read("agenda"));

export async function community(brand) {
  const cfg = brands.config(brand);
  const live = [];
  if (meta.configured(cfg.meta)) live.push(tryLive("meta", () => meta.community(cfg.meta), () => null));
  if (cfg.googleBusinessLocation && googleState().avis_autorises) {
    live.push(tryLive("avis-google", () => google.reviews(cfg.googleBusinessLocation), () => null));
  }
  if (!live.length) return store.read("community", brand);
  const results = await Promise.all(live);
  if (results.every((r) => r === null)) return store.read("community", brand);
  return results.filter(Boolean).flat().sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export async function stats(brand) {
  const seed = store.read("stats", brand);
  const cfg = brands.config(brand);
  const live = {};
  const jobs = [];
  if (meta.configured(cfg.meta)) jobs.push(tryLive("meta-stats", () => meta.stats(cfg.meta), () => ({})).then((r) => Object.assign(live, r)));
  if (cfg.tiktok.token) jobs.push(tryLive("tiktok", () => tiktok.stats(cfg.tiktok.token), () => null).then((r) => r && (live.TikTok = r)));
  if (cfg.linkedin.token && cfg.linkedin.orgId) jobs.push(tryLive("linkedin", () => linkedin.stats(cfg.linkedin), () => null).then((r) => r && (live.LinkedIn = r)));
  await Promise.all(jobs);
  for (const [platform, values] of Object.entries(live)) {
    seed.plateformes[platform] = { ...values, source: "réel" };
  }
  return seed;
}

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Les contenus de démo sont datés par rapport à aujourd'hui (« decalage_jours »).
export function calendar(brand) {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return store.read("calendar", brand).map((item) => {
    if (item.date || item.decalage_jours == null) return item;
    const { decalage_jours, ...rest } = item;
    return { ...rest, date: isoDate(new Date(today.getTime() + decalage_jours * 86400000)) };
  });
}

// Modifie un contenu du calendrier. Les dates relatives de la démo sont
// figées au passage, pour qu'un contenu ne « glisse » plus d'un jour à l'autre.
export function updateCalendarItem(brand, id, changes) {
  const list = calendar(brand);
  const item = list.find((x) => x.id === id);
  if (!item) throw Object.assign(new Error("Contenu introuvable"), { status: 404 });
  Object.assign(item, changes);
  store.write("calendar", list, brand);
  return item;
}

export function removeCalendarItem(brand, id) {
  store.write("calendar", calendar(brand).filter((x) => x.id !== id), brand);
}

export function ads(brand) {
  const cfg = brands.config(brand).meta;
  if (!meta.adsConfigured(cfg)) return store.read("ads", brand);
  return tryLive("meta-ads", () => meta.adsInsights(cfg), () => store.read("ads", brand));
}

export async function snapshot(brand) {
  const [emails, communaute, agendaDuJour, statistiques, publicite] = await Promise.all([inbox(), community(brand), agenda(), stats(brand), ads(brand)]);
  return {
    profil: store.read("profile", brand),
    emails,
    communaute,
    agenda: agendaDuJour,
    statistiques,
    publicite,
    calendrier: calendar(brand),
    notes: store.read("notes", brand),
  };
}

export const connections = (brand) => ({
  gmail: googleState(),
  marque: brands.connectionStatus(brand),
});
