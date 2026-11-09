// Tests de sécurité : requêtes envoyées par d'autres sites (CSRF) et
// DNS rebinding. Chaque attaque doit être refusée ET ne rien modifier.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-secu-"));
const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-secu-secrets-"));
const EVIL = "https://site-malveillant.example";
let server;
let port;

before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: "0",
      JURGENITA_DEMO: "1",
      JURGENITA_RUNTIME_DIR: runtimeDir,
      JURGENITA_SECRETS_DIR: secretsDir,
      JURGENITA_NO_SCHEDULER: "1",
      JURGENITA_ALLOWED_HOSTS: "",
      GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", META_ACCESS_TOKEN: "", TELEGRAM_BOT_TOKEN: "",
      TIKTOK_ACCESS_TOKEN: "", LINKEDIN_ACCESS_TOKEN: "", GOOGLE_BUSINESS_LOCATION: "",
    },
  });
  port = await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => {
      const m = String(chunk).match(/http:\/\/[\d.]+:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    server.on("exit", (code) => reject(new Error(`Le serveur s'est arrêté (code ${code})`)));
  });
});

after(() => {
  server.kill();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.rmSync(secretsDir, { recursive: true, force: true });
});

// Requête HTTP brute : contrairement à fetch, elle permet de choisir l'en-tête Host,
// comme le ferait un navigateur victime de DNS rebinding.
function raw(method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    // host: null envoie une requête sans en-tête Host du tout.
    const all = { host: `127.0.0.1:${port}`, ...headers };
    const setHost = all.host !== null;
    if (!setHost) delete all.host;
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: all, setHost }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* page HTML */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: data });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const json = (method, pathname, value, headers = {}) =>
  raw(method, pathname, { headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });

// État de référence de toutes les données qu'une action sensible pourrait modifier.
async function snapshot() {
  const read = async (p, brand) => (await raw("GET", p, { headers: brand ? { "x-marque": brand } : {} })).text;
  return {
    calendrier: await read("/api/data/calendar"),
    calendrierKora: await read("/api/data/calendar", "kora"),
    marques: await read("/api/data/brands"),
    profil: await read("/api/data/profile"),
    brouillons: await read("/api/data/drafts"),
    statut: (await json("GET", "/api/status")).body.connexions,
  };
}

// Toutes les actions qui modifient quelque chose, avec un corps valide.
const ACTIONS = [
  ["POST", "/api/calendar/update", { id: "k2", statut: "approuvé" }],
  ["POST", "/api/calendar/publish", { id: "k1" }],
  ["POST", "/api/calendar/delete", { id: "k1" }],
  ["POST", "/api/calendar", { date: "2026-12-01", plateforme: "Instagram", format: "Reel", sujet: "Pirate" }],
  ["POST", "/api/brands", { nom: "Marque pirate" }],
  ["POST", "/api/brands/delete", { id: "kora" }],
  ["PUT", "/api/brand/connexions", { meta_token: "jeton-pirate", meta_page_id: "1" }],
  ["PUT", "/api/profile", { marque: "Piratée" }],
  ["POST", "/api/community/publish", { reseau: "instagram", ref: "1", message: "pirate" }],
  ["POST", "/api/drafts", { canal: "email", destinataire: "x@mail.example", objet: "pirate", texte: "pirate" }],
  ["POST", "/api/telegram/briefing", {}],
  ["POST", "/api/reset", {}],
  ["POST", "/api/brand/validation-link", {}],
  ["POST", "/api/briefing", {}],
  ["POST", "/api/chat", { message: "bonjour" }],
];

const ATTACKS = [
  ["formulaire HTML d'un autre site", (body) => ({ headers: { "content-type": "application/x-www-form-urlencoded", origin: EVIL, "sec-fetch-site": "cross-site" }, body })],
  ["texte brut d'un autre site (sans Origin)", (body) => ({ headers: { "content-type": "text/plain" }, body })],
  ["multipart d'un autre site", (body) => ({ headers: { "content-type": "multipart/form-data; boundary=x", origin: EVIL }, body })],
  ["JSON avec une provenance étrangère", (body) => ({ headers: { "content-type": "application/json", origin: EVIL }, body })],
  ["JSON avec une provenance « null » (iframe isolée)", (body) => ({ headers: { "content-type": "application/json", origin: "null" }, body })],
  ["JSON signalé « cross-site » par le navigateur", (body) => ({ headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body })],
  ["JSON signalé « same-site » (autre port ou sous-domaine)", (body) => ({ headers: { "content-type": "application/json", "sec-fetch-site": "same-site" }, body })],
  ["DNS rebinding (nom de site étranger)", (body) => ({ headers: { "content-type": "application/json", host: `attaquant.example:${port}`, origin: `http://attaquant.example:${port}`, "sec-fetch-site": "same-origin" }, body })],
];

test("l'attaque de l'audit est bloquée : un autre site ne peut plus approuver un contenu", async () => {
  const res = await raw("POST", "/api/calendar/update", {
    headers: { "content-type": "text/plain", origin: EVIL },
    body: JSON.stringify({ id: "k2", statut: "approuvé" }),
  });
  assert.equal(res.status, 403);
  const k2 = JSON.parse((await raw("GET", "/api/data/calendar")).text).find((x) => x.id === "k2");
  assert.equal(k2.statut, "en validation");
});

test("aucune action sensible n'aboutit depuis un autre site, et rien n'est modifié", async () => {
  const before = await snapshot();
  for (const [method, pathname, value] of ACTIONS) {
    for (const [name, build] of ATTACKS) {
      const res = await raw(method, pathname, build(JSON.stringify(value)));
      assert.ok([403, 415].includes(res.status), `${method} ${pathname} — ${name} : statut ${res.status}`);
    }
  }
  assert.deepEqual(await snapshot(), before);
});

test("DNS rebinding : aucune donnée n'est lue sous un nom de site étranger", async () => {
  for (const p of ["/api/data/inbox", "/api/status", "/api/data/profile", "/api/rapport", "/", "/index.html", "/validation/x"]) {
    const res = await raw("GET", p, { headers: { host: `attaquant.example:${port}` } });
    assert.equal(res.status, 403, p);
    assert.ok(!res.text.includes("Resto-Afrik"), `${p} ne doit rien révéler`);
  }
  // Sans en-tête Host, Node refuse déjà la requête (400) avant Jurgenita.
  const noHost = await raw("GET", "/api/status", { headers: { host: null } });
  assert.ok([400, 403].includes(noHost.status), `statut ${noHost.status}`);
  const wrongPort = await raw("GET", "/api/status", { headers: { host: "127.0.0.1:1" } });
  assert.equal(wrongPort.status, 403);
});

test("un autre site ne peut pas déclencher une lecture de l'API (coût Claude, données)", async () => {
  const res = await raw("GET", "/api/rapport", { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(res.status, 403);
  // La navigation directe (adresse tapée) et les pages de Jurgenita restent permises.
  assert.equal((await raw("GET", "/api/status", { headers: { "sec-fetch-site": "none" } })).status, 200);
  assert.equal((await raw("GET", "/api/status", { headers: { "sec-fetch-site": "same-origin" } })).status, 200);
});

test("aucune requête préalable entre sites n'est autorisée (CORS)", async () => {
  const res = await raw("OPTIONS", "/api/calendar/update", {
    headers: { origin: EVIL, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });
  assert.equal(res.status, 405);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("le client ne peut valider que depuis sa propre page de validation", async () => {
  const { body: link } = await json("POST", "/api/brand/validation-link", {}, { "x-marque": "kora" });
  const apiPath = `/api${link.chemin}`;
  const { body: list } = await raw("GET", apiPath).then((r) => ({ body: JSON.parse(r.text) }));
  const pending = list.contenus.find((x) => x.statut === "en validation");
  const decision = JSON.stringify({ id: pending.id, decision: "approuver" });

  for (const [name, build] of ATTACKS) {
    const res = await raw("POST", apiPath, build(decision));
    assert.ok([403, 415].includes(res.status), `${name} : statut ${res.status}`);
  }
  const still = JSON.parse((await raw("GET", apiPath)).text).contenus.find((x) => x.id === pending.id);
  assert.equal(still.statut, "en validation");

  // Depuis sa page (même site), le client valide normalement.
  const ok = await json("POST", apiPath, { id: pending.id, decision: "approuver" }, { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.statut, "approuvé");
});

test("les requêtes légitimes de Jurgenita fonctionnent sous chaque nom local", async () => {
  for (const name of ["127.0.0.1", "localhost"]) {
    const origin = `http://${name}:${port}`;
    const res = await json("POST", "/api/calendar", { date: "2026-12-05", plateforme: "Instagram", format: "Reel", sujet: `Test ${name}` }, { host: `${name}:${port}`, origin, "sec-fetch-site": "same-origin" });
    assert.equal(res.status, 200, name);
  }
  // Un outil en ligne de commande (sans Origin) reste accepté s'il envoie du JSON.
  assert.equal((await json("POST", "/api/drafts", { canal: "email", destinataire: "a@mail.example", objet: "o", texte: "t" })).status, 200);
});

test("les en-têtes de protection sont présents sur les pages et sur l'API", async () => {
  for (const p of ["/", "/api/status", "/validation/x", "/rapport.html"]) {
    const { headers } = await raw("GET", p);
    assert.equal(headers["x-frame-options"], "DENY", p);
    assert.equal(headers["content-security-policy"], "frame-ancestors 'none'", p);
    assert.equal(headers["referrer-policy"], "no-referrer", p);
    assert.equal(headers["x-content-type-options"], "nosniff", p);
    assert.equal(headers["cross-origin-resource-policy"], "same-origin", p);
  }
  // Même une requête refusée porte ces en-têtes.
  const refused = await raw("GET", "/", { headers: { host: "attaquant.example" } });
  assert.equal(refused.headers["x-frame-options"], "DENY");
});

test("le retour de connexion Google (navigation depuis google.com) reste accepté", async () => {
  const res = await raw("GET", "/auth/google/callback?state=inconnu&code=x", { headers: { "sec-fetch-site": "cross-site", referer: "https://accounts.google.com/" } });
  assert.equal(res.status, 200);
  assert.match(res.text, /Lien de connexion expiré/, "la page de retour s'affiche ; le contrôle « state » protège la connexion");
});
