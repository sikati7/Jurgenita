// Protection contre les requêtes déclenchées par d'autres sites : CSRF
// (falsification de requête intersite) et DNS rebinding. Appliquée à chaque
// requête, avant tout traitement.
//
// Les contrôles, du plus général au plus précis :
// 1. Host : seul un nom autorisé est servi (bloque le DNS rebinding).
// 2. Sec-Fetch-Site : une requête que le navigateur signale comme venant d'un
//    autre site n'atteint pas l'API, ni en lecture ni en écriture.
// 3. Pour une action (POST, PUT…) :
//    - Origin, quand le navigateur l'envoie, doit être Jurgenita elle-même ;
//    - le corps doit être du JSON : un formulaire ou du texte brut, que tout
//      site peut faire envoyer sans contrôle du navigateur, est refusé.
// Les outils en ligne de commande, qui n'envoient ni Origin ni Sec-Fetch-Site,
// restent acceptés s'ils utilisent le bon nom de site et du JSON.

const READ_METHODS = new Set(["GET", "HEAD"]);
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

// Noms de site acceptés : la machine locale sur le port réel du serveur, plus
// ceux de JURGENITA_ALLOWED_HOSTS (ex. « jurgenita.mon-agence.fr ») pour un
// futur hébergement.
export function allowedHosts(port, extra = process.env.JURGENITA_ALLOWED_HOSTS || "") {
  const hosts = new Set(LOOPBACK_NAMES.map((name) => `${name}:${port}`));
  for (const host of extra.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)) hosts.add(host);
  return hosts;
}

export const SECURITY_HEADERS = {
  // Jurgenita ne s'affiche jamais dans le cadre d'un autre site (clickjacking
  // sur les boutons Approuver ou Publier).
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  // Aucune adresse transmise aux sites externes : le lien de validation
  // contient le jeton secret du client.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  // Les réponses ne peuvent pas être chargées par un autre site (balise image, script…).
  "Cross-Origin-Resource-Policy": "same-origin",
};

const refuse = (status, erreur) => ({ status, erreur });

function originHost(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Renvoie null si la requête est acceptée, sinon { status, erreur }.
export function check(req, hosts) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!hosts.has(host)) return refuse(403, "Nom de site non autorisé");

  // Aucune requête préalable entre sites n'est autorisée : l'API n'est
  // utilisable que depuis Jurgenita elle-même.
  if (req.method === "OPTIONS") return refuse(405, "Requêtes entre sites refusées");

  const site = req.headers["sec-fetch-site"];
  const isApi = req.url.startsWith("/api/");
  if (isApi && site === "cross-site") return refuse(403, "Requête venant d'un autre site refusée");
  if (READ_METHODS.has(req.method)) return null;

  // À partir d'ici : une action qui modifie quelque chose.
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return refuse(403, "Requête venant d'un autre site refusée");
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.has(originHost(origin))) {
    return refuse(403, "Provenance de la requête non autorisée");
  }
  const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return refuse(415, "Les actions doivent être envoyées en JSON");
  return null;
}

export const isLoopback = (host) => ["127.0.0.1", "localhost", "::1"].includes(host);
