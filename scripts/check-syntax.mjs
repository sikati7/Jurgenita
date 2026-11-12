// Vérifie la syntaxe de chaque fichier JavaScript du projet, un par un.
// Remplace « node --check src/*.js » : node --check ne contrôle que le premier
// fichier reçu, et l'invite de commandes de Windows ne développe pas « *.js ».
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function jsFiles(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(rel);
    return /\.(m?js)$/.test(entry.name) ? [rel] : [];
  });
}

const files = ["server.js", ...jsFiles("src"), ...jsFiles("scripts"), ...jsFiles("test"), path.join("public", "app.js")];
let failures = 0;
for (const file of files) {
  const run = spawnSync(process.execPath, ["--check", path.join(root, file)], { encoding: "utf8" });
  if (run.status !== 0) {
    failures++;
    console.error(`✗ ${file}\n${run.stderr}`);
  }
}
console.log(`${files.length - failures}/${files.length} fichiers sans erreur de syntaxe`);
process.exit(failures ? 1 : 0);
