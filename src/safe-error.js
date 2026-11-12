// Affichage sûr d'une erreur dans le journal.
//
// Le message d'une erreur de lecture JSON (SyntaxError) recopie un extrait du
// texte fautif, donc parfois d'un jeton ou d'un mot de passe. On n'en garde
// que la nature et la position. Pour les autres erreurs, on garde le message
// (le journal reste masqué par redact.js) et la pile d'appels, mais jamais les
// propriétés attachées à l'erreur (réponses brutes, causes, corps de requête).

const POSITION = /position (\d+)(?: \(line (\d+) column (\d+)\))?/;

export function safeMessage(err) {
  if (!(err instanceof Error)) return `valeur levée qui n'est pas une erreur (${err === null ? "null" : typeof err})`;
  if (err instanceof SyntaxError && /JSON/.test(err.message)) {
    const m = POSITION.exec(err.message);
    if (!m) return /end of JSON input/.test(err.message) ? "JSON invalide (contenu incomplet)" : "JSON invalide";
    return `JSON invalide, position ${m[1]}${m[2] ? ` (ligne ${m[2]}, colonne ${m[3]})` : ""}`;
  }
  return String(err.message);
}

// Nom, message sûr et lignes « at … » de la pile, sans la première ligne de la
// pile d'origine (qui répète le message brut).
export function safeForLog(err) {
  if (!(err instanceof Error)) return safeMessage(err);
  const frames = String(err.stack || "").split("\n").filter((line) => /^\s+at /.test(line));
  return [`${err.name || "Error"}: ${safeMessage(err)}`, ...frames].join("\n");
}
