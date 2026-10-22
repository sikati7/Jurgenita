// Petit magasin de données JSON. Les fichiers de data/ servent de graines ;
// tout ce que Jurgenita modifie (calendrier, notes, brouillons) est écrit dans
// data/runtime/ pour garder les graines intactes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, "..", "data");
const RUNTIME_DIR = path.join(DATA_DIR, "runtime");

function runtimePath(name) {
  return path.join(RUNTIME_DIR, `${name}.json`);
}

export function read(name) {
  const file = fs.existsSync(runtimePath(name))
    ? runtimePath(name)
    : path.join(DATA_DIR, `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function write(name, value) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(runtimePath(name), JSON.stringify(value, null, 2) + "\n");
  return value;
}

export function append(name, item) {
  const list = read(name);
  const withId = { id: `${name[0]}${Date.now().toString(36)}`, ...item };
  list.push(withId);
  write(name, list);
  return withId;
}

export function reset() {
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
}

// Instantané de tout le contexte utile à un briefing.
export function snapshot() {
  return {
    profil: read("profile"),
    emails: read("inbox"),
    communaute: read("community"),
    agenda: read("agenda"),
    statistiques: read("stats"),
    calendrier: read("calendar"),
    notes: read("notes"),
  };
}
