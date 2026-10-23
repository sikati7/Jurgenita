// Sources de données : les vrais comptes quand ils sont connectés, sinon les
// données de démo de data/. Une source qui échoue retombe sur la démo.
import * as store from "./store.js";
import * as google from "./connectors/google.js";
import * as meta from "./connectors/meta.js";

async function tryLive(name, live, fallback) {
  try {
    return await live();
  } catch (err) {
    console.error(`[${name}] repli sur la démo :`, err.message);
    return fallback();
  }
}

export const inbox = () => (google.connected() ? tryLive("gmail", () => google.inbox(), () => store.read("inbox")) : store.read("inbox"));
export const agenda = () => (google.connected() ? tryLive("agenda", () => google.agenda(), () => store.read("agenda")) : store.read("agenda"));
export const community = () => (meta.configured() ? tryLive("meta", () => meta.community(), () => store.read("community")) : store.read("community"));

export async function stats() {
  const seed = store.read("stats");
  if (!meta.configured()) return seed;
  const live = await tryLive("meta-stats", () => meta.stats(), () => ({}));
  for (const [platform, values] of Object.entries(live)) {
    seed.plateformes[platform] = { ...values, source: "réel" };
  }
  return seed;
}

export async function snapshot() {
  const [emails, communaute, agendaDuJour, statistiques] = await Promise.all([inbox(), community(), agenda(), stats()]);
  return {
    profil: store.read("profile"),
    emails,
    communaute,
    agenda: agendaDuJour,
    statistiques,
    calendrier: store.read("calendar"),
    notes: store.read("notes"),
  };
}

export const connections = () => ({
  gmail: { configure: google.configured(), connecte: google.connected() },
  meta: { configure: meta.configured() },
});
