// Petit magasin de données JSON. Les fichiers de data/ servent de graines ;
// tout ce que Jurgenita modifie (calendrier, notes, brouillons, marques) est
// écrit dans data/runtime/ pour garder les graines intactes.
//
// Données globales (votre boîte mail, votre agenda) : data/<nom>.json
// Données d'une marque : data/brands/<marque>/<nom>.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, "..", "data");
// Surchargeable pour les tests, qui ne doivent pas toucher aux vraies données.
const RUNTIME_DIR = process.env.JURGENITA_RUNTIME_DIR || path.join(DATA_DIR, "runtime");

// Ce que contient une marque créée depuis l'interface, avant toute donnée.
const BRAND_DEFAULTS = {
  community: [],
  stats: { periode: "7 derniers jours", plateformes: {}, heures_fortes: {} },
  calendar: [],
  notes: [],
  ads: { periode: "7 derniers jours", devise: "EUR", annonces: [] },
  veille: { mentions: [], concurrents: [], tendances: [] },
};

export function checkBrandId(brand) {
  if (!/^[a-z0-9-]{1,40}$/.test(brand)) throw Object.assign(new Error("Marque inconnue"), { status: 404 });
  return brand;
}

function paths(name, brand) {
  if (!brand) return [path.join(RUNTIME_DIR, `${name}.json`), path.join(DATA_DIR, `${name}.json`)];
  checkBrandId(brand);
  return [path.join(RUNTIME_DIR, "brands", brand, `${name}.json`), path.join(DATA_DIR, "brands", brand, `${name}.json`)];
}

export function read(name, brand) {
  const [runtime, seed] = paths(name, brand);
  if (fs.existsSync(runtime)) return JSON.parse(fs.readFileSync(runtime, "utf8"));
  if (fs.existsSync(seed)) return JSON.parse(fs.readFileSync(seed, "utf8"));
  if (brand && name in BRAND_DEFAULTS) return structuredClone(BRAND_DEFAULTS[name]);
  throw Object.assign(new Error(`Données introuvables : ${name}`), { status: 404 });
}

export function write(name, value, brand) {
  const [runtime] = paths(name, brand);
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(runtime, JSON.stringify(value, null, 2) + "\n");
  return value;
}

export function append(name, item, brand) {
  const list = read(name, brand);
  const withId = { id: `${name[0]}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, ...item };
  list.push(withId);
  write(name, list, brand);
  return withId;
}

// Modifie un élément d'une liste par son identifiant.
export function update(name, id, changes, brand) {
  const list = read(name, brand);
  const item = list.find((x) => x.id === id);
  if (!item) throw Object.assign(new Error("Élément introuvable"), { status: 404 });
  Object.assign(item, changes);
  write(name, list, brand);
  return item;
}

export function remove(name, id, brand) {
  write(name, read(name, brand).filter((x) => x.id !== id), brand);
}

export function reset() {
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
}
