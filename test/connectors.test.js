// Tests des connecteurs (Google, Meta, TikTok, LinkedIn, Telegram) et de la
// publication programmée, avec des réponses simulées : aucune requête ne sort
// vers Internet et aucune donnée réelle n'est touchée.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-secrets-"));
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jurgenita-runtime-"));
// Les variables META_* et co. s'appliquent à la première marque (resto-afrik).
Object.assign(process.env, {
  JURGENITA_SECRETS_DIR: secretsDir,
  JURGENITA_RUNTIME_DIR: runtimeDir,
  GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret",
  META_ACCESS_TOKEN: "tok", META_IG_USER_ID: "ig1", META_PAGE_ID: "pg1", META_AD_ACCOUNT_ID: "act_77",
  GOOGLE_BUSINESS_LOCATION: "accounts/1/locations/2",
  TIKTOK_ACCESS_TOKEN: "tt", LINKEDIN_ACCESS_TOKEN: "li", LINKEDIN_ORG_ID: "555",
  TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "42",
});
const BRAND = "resto-afrik";

const calls = [];
const realFetch = globalThis.fetch;
const b64url = (s) => Buffer.from(s).toString("base64url");
const routes = [
  [/oauth2\.googleapis\.com\/token/, () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "gmail.readonly https://www.googleapis.com/auth/business.manage" })],
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
  [/mybusiness.*\/reviews\/r9\/reply/, () => ({})],
  [/mybusiness.*\/reviews/, () => ({ reviews: [{ reviewId: "r9", name: "accounts/1/locations/2/reviews/r9", reviewer: { displayName: "Lina" }, starRating: "TWO", comment: "Trop d'attente", createTime: "2026-10-22T13:00:00Z" }] })],
  [/ig1\/media_publish/, () => ({ id: "ig_post_1" })],
  [/ig1\/media.*like_count/, () => ({ data: [{ like_count: 10, comments_count: 2, caption: "Ndolé" }, { like_count: 30, comments_count: 4, caption: "Poulet DG" }] })],
  [/ig1\/media$/, (o) => (o.method === "POST" ? { id: "container_1" } : null)],
  [/ig1\/media\?/, () => ({ data: [{ id: "m1", caption: "Ndolé de Maman" }] })],
  [/m1\/comments/, () => ({ data: [{ id: "c1", text: "Trop bon", username: "nadia", timestamp: "2026-10-22T11:00:00+0000" }] })],
  [/pg1\/posts/, () => ({ data: [{ message: "Samedi", comments: { data: [{ id: "f1", message: "Top", from: { name: "Paul" }, created_time: "2026-10-22T12:00:00+0000" }] } }] })],
  [/pg1\/conversations.*platform=instagram/, () => ({ data: [{ id: "conv1", messages: { data: [{ id: "msg1", message: "Vous livrez ?", from: { id: "igsid_9", username: "lea" }, created_time: "2026-10-22T15:00:00+0000" }] } }] })],
  [/pg1\/conversations.*platform=messenger/, () => ({ data: [{ id: "conv2", messages: { data: [{ id: "msg2", message: "Merci !", from: { id: "pg1" }, created_time: "2026-10-22T14:00:00+0000" }] } }] })],
  [/pg1\/messages/, () => ({ message_id: "m_out" })],
  [/pg1\/feed/, () => ({ id: "pg1_post_2" })],
  [/ig1\?/, () => ({ followers_count: 38500, media_count: 210 })],
  [/pg1\?/, () => ({ followers_count: 9900 })],
  [/c1\/replies/, () => ({ id: "r1" })],
  [/act_77\/insights/, () => ({ data: [{ ad_name: "Reel ndolé", campaign_name: "Paris", spend: "84.2", impressions: "41200", clicks: "1180", ctr: "2.864", cpc: "0.0713", actions: [{ action_type: "purchase", value: "7" }, { action_type: "link_click", value: "1180" }], purchase_roas: [{ action_type: "omni_purchase", value: "3.456" }] }] })],
  [/open\.tiktokapis\.com\/v2\/user\/info/, () => ({ data: { user: { follower_count: 61200, likes_count: 900000, video_count: 120 } }, error: { code: "ok" } })],
  [/open\.tiktokapis\.com\/v2\/video\/list/, () => ({ data: { videos: [{ title: "Les secrets de Maman", view_count: 410000 }, { title: "Plantain", view_count: 8000 }] }, error: { code: "ok" } })],
  [/api\.linkedin\.com\/rest\/networkSizes/, () => ({ firstDegreeSize: 1250 })],
  [/api\.telegram\.org/, () => ({ ok: true, result: {} })],
];

before(() => {
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    calls.push({ url, options });
    const route = routes.find(([re]) => re.test(url));
    const data = route?.[1](options);
    if (!data) return { ok: false, status: 404, json: async () => ({ error: { message: `non simulé : ${url.split("?")[0]}` } }) };
    return { ok: true, status: 200, json: async () => data };
  };
});

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(secretsDir, { recursive: true, force: true });
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

const google = await import("../src/connectors/google.js");
const meta = await import("../src/connectors/meta.js");
const telegram = await import("../src/connectors/telegram.js");
const brands = await import("../src/brands.js");
const sources = await import("../src/sources.js");
const store = await import("../src/store.js");
const publisher = await import("../src/publisher.js");
const demo = await import("../src/demo.js");
const lastCall = (re) => calls.findLast((c) => re.test(c.url));

// ---------- Google ----------

test("Google : connexion, lecture de la boîte et de l'agenda", async () => {
  assert.equal(google.connected(), false);
  assert.match(google.authUrl("http://127.0.0.1:3000/cb", "etat"), /business\.manage.*access_type=offline.*state=etat/);
  await google.handleCallback("code", "http://127.0.0.1:3000/cb");
  assert.equal(google.connected(), true);
  assert.equal(google.hasBusinessScope(), true);

  const [mail] = await sources.inbox();
  assert.equal(mail.de, "Ana <ana@mail.example>");
  assert.equal(mail.corps, "Bonjour, un devis ?", "le texte brut doit être préféré au HTML");
  assert.deepEqual(await sources.agenda(), [{ heure: "09:30", titre: "Tournage", lieu: "" }]);
});

test("Google : le brouillon répond dans le bon fil et encode les accents", async () => {
  await google.createDraft({ to: "ana@mail.example", subject: "Re: Devis été", body: "Bonjour Ana", threadId: "t1", inReplyTo: "<abc@mail.example>" });
  const sent = JSON.parse(lastCall(/\/drafts/).options.body);
  const raw = Buffer.from(sent.message.raw, "base64url").toString("utf8");
  assert.equal(sent.message.threadId, "t1");
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(raw, /^In-Reply-To: <abc@mail\.example>/m);
  assert.match(raw, /\r\n\r\nBonjour Ana$/);
});

test("Google : avis lus avec leur note, réponse publiée sur le bon avis", async () => {
  const [review] = await google.reviews("accounts/1/locations/2");
  assert.equal(review.note, 2);
  assert.equal(review.type, "avis");
  await google.replyReview(review.ref, "Merci Lina");
  const call = lastCall(/\/reply$/);
  assert.equal(call.options.method, "PUT");
  assert.equal(JSON.parse(call.options.body).comment, "Merci Lina");
});

// ---------- Meta ----------

test("Meta : commentaires, messages privés et avis réunis, du plus récent au plus ancien", async () => {
  const items = await sources.community(BRAND);
  assert.deepEqual(items.map((i) => i.id), ["dm_msg1", "gr_r9", "fb_f1", "ig_c1"]);
  const dm = items[0];
  assert.equal(dm.type, "DM");
  assert.equal(dm.ref, "igsid_9", "on répond à l'expéditeur, pas à la conversation");
  assert.ok(!items.some((i) => i.id === "dm_msg2"), "les messages envoyés par la page sont ignorés");
});

test("Meta : réponse à un commentaire et à un message privé", async () => {
  const cfg = brands.config(BRAND).meta;
  await meta.reply(cfg, { reseau: "instagram", ref: "c1", message: "Merci !" });
  assert.match(calls.at(-1).url, /\/c1\/replies$/);
  await meta.reply(cfg, { reseau: "instagram_dm", ref: "igsid_9", message: "Oui, à Montreuil" });
  const body = new URLSearchParams(calls.at(-1).options.body);
  assert.deepEqual(JSON.parse(body.get("recipient")), { id: "igsid_9" });
  assert.equal(body.get("messaging_type"), "RESPONSE");
  await assert.rejects(meta.reply(cfg, { reseau: "inconnu", ref: "x", message: "y" }));
});

test("Meta : publication Instagram en deux temps, Facebook en un", async () => {
  const cfg = brands.config(BRAND).meta;
  await assert.rejects(meta.publish(cfg, { plateforme: "Instagram", legende: "x", image_url: "" }), /exige une image/);
  assert.equal(await meta.publish(cfg, { plateforme: "Instagram", legende: "Miam", image_url: "https://img.example/a.jpg" }), "ig_post_1");
  assert.equal(new URLSearchParams(lastCall(/ig1\/media_publish/).options.body).get("creation_id"), "container_1");
  assert.equal(await meta.publish(cfg, { plateforme: "Facebook", legende: "Bonjour" }), "pg1_post_2");
  await assert.rejects(meta.publish(cfg, { plateforme: "TikTok" }), /non disponible/);
});

test("Meta Ads : performances converties en chiffres", async () => {
  const { annonces, source } = await sources.ads(BRAND);
  assert.equal(source, "réel");
  assert.deepEqual(annonces[0], { annonce: "Reel ndolé", campagne: "Paris", depense: 84.2, impressions: 41200, clics: 1180, ctr: 2.86, cpc: 0.07, conversions: 7, roas: 3.46 });
});

// ---------- Statistiques TikTok et LinkedIn ----------

test("Statistiques : Instagram, Facebook, TikTok et LinkedIn en direct", async () => {
  const { plateformes } = await sources.stats(BRAND);
  assert.equal(plateformes.Instagram.abonnes, 38500);
  assert.equal(plateformes.Instagram.meilleur_post, "Poulet DG");
  assert.equal(plateformes.Facebook.abonnes, 9900);
  assert.equal(plateformes.TikTok.abonnes, 61200);
  assert.equal(plateformes.TikTok.vues_moyennes, 209000);
  assert.equal(plateformes.LinkedIn.abonnes, 1250);
  assert.equal(plateformes["YouTube Shorts"].source, undefined, "les plateformes non connectées gardent la démo");
});

test("Les accès de la première marque ne s'appliquent pas aux autres", () => {
  assert.equal(brands.connectionStatus("kora").meta, false);
  assert.equal(brands.config("kora").meta.token, "");
});

// ---------- Publication programmée ----------

test("Publication programmée : publie, signale le manuel et les échecs", async () => {
  store.write("calendar", [
    { id: "p1", date: "2026-01-01", heure: "10:00", plateforme: "Instagram", format: "Reel", sujet: "A", legende: "a", image_url: "https://img.example/a.jpg", statut: "approuvé" },
    { id: "p2", date: "2026-01-01", heure: "10:00", plateforme: "TikTok", format: "Vidéo", sujet: "B", legende: "b", image_url: "", statut: "approuvé" },
    { id: "p3", date: "2026-01-01", heure: "10:00", plateforme: "Instagram", format: "Photo", sujet: "C", legende: "c", image_url: "", statut: "approuvé" },
    { id: "p4", date: "2026-01-01", heure: "10:00", plateforme: "Instagram", format: "Photo", sujet: "D", legende: "d", image_url: "https://img.example/d.jpg", statut: "en validation" },
    { id: "p5", date: "2099-01-01", heure: "10:00", plateforme: "Facebook", format: "Post", sujet: "E", legende: "e", image_url: "", statut: "approuvé" },
    { id: "p6", demo: true, date: "2026-01-01", heure: "10:00", plateforme: "Facebook", format: "Post", sujet: "F", legende: "f", image_url: "", statut: "approuvé" },
  ], BRAND);
  const messages = [];
  await publisher.tick(async (m) => messages.push(m), new Date("2026-06-01T12:00:00"));
  const byId = Object.fromEntries(sources.calendar(BRAND).map((x) => [x.id, x]));
  assert.equal(byId.p1.statut, "publié");
  assert.equal(byId.p1.post_id, "ig_post_1");
  assert.equal(byId.p2.statut, "à publier manuellement");
  assert.equal(byId.p3.statut, "échec");
  assert.match(byId.p3.erreur, /exige une image/);
  assert.equal(byId.p4.statut, "en validation", "un contenu non approuvé ne part jamais");
  assert.equal(byId.p5.statut, "approuvé", "un contenu futur attend son heure");
  assert.equal(byId.p6.statut, "à publier manuellement", "un contenu de démo ne part jamais sur un vrai compte");
  assert.ok(!calls.some((c) => /pg1\/feed/.test(c.url) && new URLSearchParams(c.options.body).get("message") === "f"));
  assert.equal(messages.length, 4);
  sources.updateCalendarItem(BRAND, "p6", { statut: "approuvé" });
  await assert.rejects(publisher.publishNow(BRAND, "p6"), /démonstration/);
});

// ---------- Telegram et repli ----------

test("Telegram : le briefing est envoyé au bon chat, découpé si trop long", async () => {
  const text = telegram.formatBriefing(await demo.briefing("kora"));
  assert.match(text, /PRIORITÉS/);
  calls.length = 0;
  await telegram.send("x".repeat(9000));
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[0].options.body).chat_id, "42");
});

test("Une source en panne retombe sur les données de démo", async () => {
  process.env.META_IG_USER_ID = "panne";
  process.env.META_PAGE_ID = "";
  process.env.GOOGLE_BUSINESS_LOCATION = "";
  const items = await sources.community(BRAND);
  assert.equal(items[0].id, "c1", "les commentaires de démo sont renvoyés");
  Object.assign(process.env, { META_IG_USER_ID: "ig1", META_PAGE_ID: "pg1", GOOGLE_BUSINESS_LOCATION: "accounts/1/locations/2" });
  google.disconnect();
  assert.equal(google.connected(), false);
});
