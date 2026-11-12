// Tests propres à Windows. Ils ne s'exécutent que sur un vrai Windows (CI
// windows-latest) ; ailleurs, ils apparaissent comme « ignorés » (skip), jamais
// en silence. Le CI vérifie en plus qu'aucun n'est ignoré sous Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic, readJsonFile, leftoverTemps } from "../src/atomic-file.js";

const onlyWindows = { skip: process.platform === "win32" ? false : "réservé à Windows" };

test("Windows : l'environnement est un vrai Windows", onlyWindows, () => {
  assert.equal(process.platform, "win32");
  assert.equal(os.type(), "Windows_NT");
  console.log(`# ${os.type()} ${os.release()}, Node ${process.version}`);
});

test("Windows : PowerShell 5.1 et icacls sont disponibles", onlyWindows, () => {
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
  assert.equal(ps.status, 0, ps.stderr);
  assert.equal(ps.stdout.trim(), "5", "Windows PowerShell 5.1 (celui livré avec Windows)");
  const acl = spawnSync("icacls", [os.tmpdir()], { encoding: "utf8" });
  assert.equal(acl.status, 0, acl.stderr);
});

test("Windows : l'écriture atomique remplace un fichier existant sur NTFS", onlyWindows, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-ntfs-"));
  try {
    const file = path.join(dir, "kora.json");
    for (let i = 0; i < 50; i++) writeJsonAtomic(file, { version: i, texte: "é ✨" });
    assert.deepEqual(readJsonFile(file), { etat: "ok", valeur: { version: 49, texte: "é ✨" } });
    assert.deepEqual(leftoverTemps(dir), [], "aucun fichier temporaire laissé");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TÉMOIN TEMPORAIRE : doit échouer sous Windows", onlyWindows, () => {
  assert.fail("Témoin : ce test prouve que les tests propres à Windows s'exécutent réellement. Il sera retiré.");
});
