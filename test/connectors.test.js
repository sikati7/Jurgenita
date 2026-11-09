// Tests des connecteurs Google, Meta et Telegram avec des réponses simulées :
// aucune requête ne sort vers Internet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-secrets-"));
Object.assign(process.env, {
  JURGENITA_SECRETS_DIR: secretsDir,
  GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret",
  META_ACCESS_TOKEN: "tok", META_IG_USER_ID: "ig1", META_PAGE_ID: "pg1",
  TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "42",
});

const calls = [];
const realFetch = globalThis.fetch;
const b64url = (s) => Buffer.from(s).toString("base64url");
const routes = [
  [/oauth2\.googleapis\.com\/token/, () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600 })],
  [/gmail.*\/messages\?/, () => ({ messages: [{ id: "g1" }] })],
  [/gmail.*\/messages\/g1/, () => ({
    id: "g1", threadId: "t1", internalDate: "1761200000000", snippet: "",
    payload: {
      mimeType: "multipart/alternative",
      headers: [{ name: "From", value: "Ana <ana@mail.example>" }, { name: "Subject", value: "Devis" }, { name: "Message-ID", value: "<abc@mail.example>" }],
      parts: [{ mimeType: "text/html", body: { data: b64url("<p>Version HTML</p>") } }, { mimeType: "text/plain", body: { data: b64url("Bonjour, un devis ?") } }],
    },
  })],
  [/gmail.*\/drafts/, () => ({ id: "d1" })],
  [/calendar\/v3/, () => ({ items: [{ summary: "Tournage", start: { dateTime: "2026-10-23T09:30:00+02:00" } }] })],
  [/ig1\/media.*like_count/, () => ({ data: [{ like_count: 10, comments_count: 2, caption: "Ndolé" }, { like_count: 30, comments_count: 4, caption: "Poulet DG" }] })],
  [/ig1\/media/, () => ({ data: [{ id: "m1", caption: "Ndolé de Maman" }] })],
  [/m1\/comments/, () => ({ data: [{ id: "c1", text: "Trop bon", username: "nadia", timestamp: "2026-10-22T11:00:00+0000" }] })],
  [/pg1\/posts/, () => ({ data: [{ message: "Samedi", comments: { data: [{ id: "f1", message: "Top", from: { name: "Paul" }, created_time: "2026-10-22T12:00:00+0000" }] } }] })],
  [/ig1\?/, () => ({ followers_count: 38500, media_count: 210 })],
  [/pg1\?/, () => ({ followers_count: 9900 })],
  [/c1\/replies/, () => ({ id: "r1" })],
  [/api\.telegram\.org/, () => ({ ok: true, result: {} })],
];

before(() => {
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    calls.push({ url, options });
    const route = routes.find(([re]) => re.test(url));
    if (!route) return { ok: false, status: 404, json: async () => ({ error: { message: `non simulé : ${url}` } }) };
    return { ok: true, status: 200, json: async () => route[1]() };
  };
});

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(secretsDir, { recursive: true, force: true });
});

const google = await import("../src/connectors/google.js");
const meta = await import("../src/connectors/meta.js");
const telegram = await import("../src/connectors/telegram.js");
const sources = await import("../src/sources.js");
const demo = await import("../src/demo.js");

test("Google : connexion, lecture de la boîte et de l'agenda", async () => {
  assert.equal(google.connected(), false);
  assert.match(google.authUrl("http://127.0.0.1:3000/cb", "etat"), /access_type=offline.*state=etat/);
  await google.handleCallback("code", "http://127.0.0.1:3000/cb");
  assert.equal(google.connected(), true);

  const [mail] = await sources.inbox();
  assert.equal(mail.de, "Ana <ana@mail.example>");
  assert.equal(mail.corps, "Bonjour, un devis ?", "le texte brut doit être préféré au HTML");
  assert.equal(mail.messageId, "<abc@mail.example>");
  assert.deepEqual(await sources.agenda(), [{ heure: "09:30", titre: "Tournage", lieu: "" }]);
});

test("Google : le brouillon répond dans le bon fil et encode les accents", async () => {
  await google.createDraft({ to: "ana@mail.example", subject: "Re: Devis été", body: "Bonjour Ana", threadId: "t1", inReplyTo: "<abc@mail.example>" });
  const sent = JSON.parse(calls.findLast((c) => c.url.includes("/drafts")).options.body);
  const raw = Buffer.from(sent.message.raw, "base64url").toString("utf8");
  assert.equal(sent.message.threadId, "t1");
  assert.match(raw, /^To: ana@mail\.example/m);
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(raw, /^In-Reply-To: <abc@mail\.example>/m);
  assert.match(raw, /\r\n\r\nBonjour Ana$/);
  google.disconnect();
  assert.equal(google.connected(), false);
});

test("Meta : commentaires Instagram et Facebook, du plus récent au plus ancien", async () => {
  const items = await sources.community();
  assert.deepEqual(items.map((i) => i.id), ["fb_f1", "ig_c1"]);
  assert.equal(items[1].auteur, "@nadia");
});

test("Meta : les vrais chiffres remplacent ceux de la démo", async () => {
  const { plateformes } = await sources.stats();
  assert.equal(plateformes.Instagram.abonnes, 38500);
  assert.equal(plateformes.Instagram.interactions_moyennes_par_post, 23);
  assert.equal(plateformes.Instagram.meilleur_post, "Poulet DG");
  assert.equal(plateformes.Facebook.abonnes, 9900);
  assert.equal(plateformes.TikTok.source, undefined, "les plateformes non connectées gardent la démo");
});

test("Meta : une réponse est publiée sur le bon commentaire", async () => {
  await meta.reply({ reseau: "instagram", ref: "c1", message: "Merci !" });
  const last = calls.at(-1);
  assert.match(last.url, /\/c1\/replies$/);
  assert.equal(last.options.method, "POST");
  await assert.rejects(meta.reply({ reseau: "inconnu", ref: "x", message: "y" }));
});

test("Telegram : le briefing est envoyé au bon chat, découpé si trop long", async () => {
  const text = telegram.formatBriefing(await demo.briefing());
  assert.match(text, /PRIORITÉS/);
  calls.length = 0;
  await telegram.send("x".repeat(9000));
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[0].options.body).chat_id, "42");
});

test("une source en panne retombe sur les données de démo", async () => {
  process.env.META_IG_USER_ID = "panne";
  process.env.META_PAGE_ID = "";
  const items = await sources.community();
  assert.equal(items[0].id, "c1", "les commentaires de démo sont renvoyés");
  process.env.META_IG_USER_ID = "ig1";
  process.env.META_PAGE_ID = "pg1";
});
