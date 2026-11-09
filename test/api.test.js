// Tests de bout en bout de l'API, en mode démo (aucune clé ni compte requis).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-test-"));
let server;
let base;

before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: "0",
      JURGENITA_DEMO: "1",
      JURGENITA_RUNTIME_DIR: runtimeDir,
      // Les connecteurs restent éteints, même si un .env local les configure.
      GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", META_ACCESS_TOKEN: "", TELEGRAM_BOT_TOKEN: "",
    },
  });
  base = await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => {
      const m = String(chunk).match(/http:\/\/[\d.]+:(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    server.on("exit", (code) => reject(new Error(`Le serveur s'est arrêté (code ${code})`)));
  });
});

after(() => {
  server.kill();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

async function call(pathname, body, method = body === undefined ? "GET" : "POST") {
  const res = await fetch(base + pathname, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("le statut annonce le mode démo et aucune connexion", async () => {
  const { status, body } = await call("/api/status");
  assert.equal(status, 200);
  assert.equal(body.mode, "demo");
  assert.equal(body.connexions.gmail.connecte, false);
  assert.equal(body.connexions.meta.configure, false);
  assert.equal(body.connexions.telegram.pret, false);
});

test("le briefing trie chaque email et propose des priorités", async () => {
  const { body } = await call("/api/briefing", {});
  const inbox = (await call("/api/data/inbox")).body;
  assert.equal(body.emails.length, inbox.length);
  assert.ok(body.priorites.length >= 3);
  for (const e of body.emails) {
    assert.ok(["urgent", "a_repondre", "opportunite", "a_deleguer", "a_ignorer"].includes(e.categorie));
    if (e.repondre) assert.ok(e.brouillon.length > 0, `brouillon manquant pour ${e.id}`);
  }
  // La règle du profil « pas d'alcool fort » doit être respectée.
  assert.equal(body.emails.find((e) => e.id === "m7").categorie, "a_ignorer");
});

test("une réponse peut être rédigée pour un email existant, pas pour un inconnu", async () => {
  assert.equal((await call("/api/email/reply", { id: "m1" })).status, 200);
  assert.equal((await call("/api/email/reply", { id: "inconnu" })).status, 500);
});

test("le studio exige un sujet et renvoie un post par plateforme", async () => {
  assert.equal((await call("/api/studio", { sujet: " " })).status, 400);
  const { body } = await call("/api/studio", { sujet: "Le koki", plateformes: ["Instagram", "TikTok", "LinkedIn"] });
  assert.deepEqual(body.posts.map((p) => p.plateforme), ["Instagram", "TikTok", "LinkedIn"]);
  assert.ok(body.script_video.length > 0);
});

test("l'analyse visuelle refuse une requête sans image", async () => {
  assert.equal((await call("/api/vision", { images: [] })).status, 400);
  const { body } = await call("/api/vision", { images: [{ media_type: "image/jpeg", data: "AAAA" }] });
  assert.equal(typeof body.note_accroche, "number");
});

test("la console répond aux questions d'expertise", async () => {
  assert.equal((await call("/api/chat", { message: "" })).status, 400);
  const { body } = await call("/api/chat", { message: "Quelle est la meilleure heure pour publier ?" });
  assert.match(body.texte, /Instagram/);
});

test("le calendrier et les brouillons sont enregistrés hors des données de démo", async () => {
  const added = (await call("/api/calendar", { date: "2026-12-01", plateforme: "TikTok", format: "Vidéo", sujet: "Test" })).body;
  const calendar = (await call("/api/data/calendar")).body;
  assert.ok(calendar.some((x) => x.id === added.id));
  assert.ok(fs.existsSync(path.join(runtimeDir, "calendar.json")));
  await call("/api/reset", {});
  assert.ok(!(await call("/api/data/calendar")).body.some((x) => x.id === added.id));
});

test("Telegram et la publication Meta refusent tant qu'ils ne sont pas configurés", async () => {
  assert.equal((await call("/api/telegram/briefing", {})).status, 400);
  assert.equal((await call("/api/community/publish", { reseau: "instagram", ref: "1", message: "x" })).status, 400);
});

test("les données inconnues et les chemins hors de public/ sont refusés", async () => {
  assert.equal((await call("/api/data/secrets")).status, 404);
  const res = await fetch(`${base}/..%2Fserver.js`);
  assert.equal(res.status, 404);
  const home = await fetch(`${base}/`);
  assert.match(await home.text(), /J·U·R·G·E·N·I·T·A/);
});
