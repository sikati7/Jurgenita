// Masquage des secrets dans les journaux et dans les messages d'erreur.
// Deux protections complémentaires :
// - des motifs reconnus (jetons Meta, Google, Telegram, Anthropic, paramètres
//   d'URL sensibles, en-têtes Authorization) ;
// - les valeurs exactes des secrets configurés (.env et accès des marques),
//   fournies par des « sources » enregistrées au démarrage.
import util from "node:util";

const MASK = "[masqué]";

const PATTERNS = [
  // Paramètres d'URL ou de formulaire : access_token=…, refresh_token=…, client_secret=…
  [/\b(access_token|refresh_token|client_secret|id_token|code|token)=([^&\s"'<>]+)/gi, (_, name) => `${name}=${MASK}`],
  // En-têtes et textes « Bearer … » / « OAuth … »
  [/\b(Bearer|OAuth)\s+[A-Za-z0-9._~+/=-]{8,}/g, (_, type) => `${type} ${MASK}`],
  // Clés Anthropic
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, MASK],
  // Jeton de bot Telegram, seul ou dans l'adresse de l'API (bot123456:ABC…)
  [/\b(bot)?\d{6,}:[A-Za-z0-9_-]{30,}/g, MASK],
  // Jetons Meta (EAA…) et Google (ya29.…, 1//…)
  [/\bEAA[A-Za-z0-9]{20,}/g, MASK],
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, MASK],
  [/\b1\/\/[A-Za-z0-9._-]{10,}/g, MASK],
];

// Valeurs secrètes connues : chaque source renvoie une liste de chaînes.
const sources = new Set();
const MIN_SECRET_LENGTH = 8; // en dessous, ce sont des identifiants, pas des secrets

export function addSecretSource(fn) {
  sources.add(fn);
}

function knownSecrets() {
  const values = new Set();
  for (const fn of sources) {
    try {
      for (const v of fn() || []) if (typeof v === "string" && v.length >= MIN_SECRET_LENGTH) values.add(v);
    } catch {
      // une source illisible ne doit jamais empêcher d'écrire un journal
    }
  }
  // Les plus longues d'abord, pour qu'un secret contenu dans un autre soit bien masqué.
  return [...values].sort((a, b) => b.length - a.length);
}

export function redact(text) {
  let out = String(text);
  for (const secret of knownSecrets()) out = out.split(secret).join(MASK);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// Remplace console.log/info/warn/error par des versions qui masquent les secrets,
// quel que soit le module qui écrit (connecteurs compris).
let installed = false;
export function installConsoleRedaction() {
  if (installed) return;
  installed = true;
  for (const method of ["log", "info", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(redact(util.formatWithOptions({ colors: false }, ...args)));
  }
}
