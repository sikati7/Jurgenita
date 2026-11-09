// Appels à Claude : sorties structurées pour les modules (briefing, mails,
// studio, communauté, publicité, veille, rapports) et un agent avec outils
// pour la conversation libre. Tout porte sur une marque (`brand`).
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as store from "./store.js";
import * as sources from "./sources.js";
import { PERSONA, VOICE_HINT } from "./prompts.js";
import * as schemas from "./schemas.js";

export const MODEL = process.env.JURGENITA_MODEL || "claude-opus-5-5";

// En cas de refus d'un classifieur de sécurité, l'API relance la requête sur
// le modèle de repli recommandé au lieu de renvoyer un refus.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

const SYSTEM = [{ type: "text", text: PERSONA, cache_control: { type: "ephemeral" } }];
const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 5 };

let client;
function getClient() {
  client ??= new Anthropic();
  return client;
}

function today() {
  return new Date().toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Paris" });
}

export class RefusalError extends Error {}

async function structured(schema, content, effort = "medium") {
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort, format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content }],
    ...FALLBACK,
  });
  if (response.stop_reason === "refusal") {
    throw new RefusalError("Jurgenita a décliné cette demande.");
  }
  if (!response.parsed_output) {
    throw new Error(`Réponse illisible (stop_reason: ${response.stop_reason})`);
  }
  return response.parsed_output;
}

const json = (value) => JSON.stringify(value, null, 2);
const profile = (brand) => `<profil_de_la_marque>${json(store.read("profile", brand))}</profil_de_la_marque>`;

export async function briefing(brand) {
  const ctx = await sources.snapshot(brand);
  return structured(
    schemas.Briefing,
    `Nous sommes le ${today()}. C'est l'heure du réveil : prépare le briefing du matin pour la marque ${ctx.profil.marque}.

Trie chaque email (urgent, à répondre, opportunité, à déléguer, à ignorer), dis s'il faut répondre et rédige le brouillon quand c'est le cas.
Pour la communauté, propose une réponse à chaque élément qui le mérite et la modération adaptée.
Propose 3 idées de contenu inspirées des statistiques, de la communauté, de la publicité et de l'agenda.
${VOICE_HINT}

<contexte>
${json(ctx)}
</contexte>`,
    "high",
  );
}

export async function emailReply({ id, intention }, brand) {
  const email = (await sources.inbox()).find((m) => m.id === id);
  if (!email) throw Object.assign(new Error(`Email ${id} introuvable`), { status: 404 });
  return structured(
    schemas.EmailReply,
    `Rédige la réponse à cet email.
Intention de l'utilisateur : ${intention || "à toi de choisir la meilleure réponse"}

${profile(brand)}
<statistiques>${json(await sources.stats(brand))}</statistiques>
<email>${json(email)}</email>`,
  );
}

export async function contentStudio({ sujet, plateformes, objectif }, brand) {
  return structured(
    schemas.ContentPack,
    `Crée un pack de contenu complet.
Sujet : ${sujet}
Plateformes : ${(plateformes?.length ? plateformes : ["Instagram", "TikTok"]).join(", ")}
Objectif : ${objectif || "engagement et nouveaux abonnés"}

Pour chaque plateforme, adapte le format, l'accroche et la légende à ses codes. Le script vidéo doit tenir en 30 à 45 secondes.

${profile(brand)}
<statistiques>${json(await sources.stats(brand))}</statistiques>`,
  );
}

export async function communityTriage(brand) {
  return structured(
    schemas.CommunityTriage,
    `Analyse les interactions récentes de la communauté (commentaires, messages privés, avis), propose une réponse pour chacune et la modération adaptée. Les messages privés et les avis négatifs demandent une réponse personnelle et une solution concrète. Repère aussi les idées de contenu qu'elles inspirent.

${profile(brand)}
<interactions>${json(await sources.community(brand))}</interactions>`,
  );
}

// Analyse d'une photo ou d'images extraites d'une vidéo.
export function visionReport({ images, contexte, video }, brand) {
  return structured(
    schemas.VisionReport,
    [
      ...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } })),
      {
        type: "text",
        text: `${video ? `Voici ${images.length} images extraites d'une vidéo, dans l'ordre chronologique.` : "Voici une photo."} Analyse ce contenu comme une directrice de création réseaux sociaux : est-ce qu'il arrête le scroll ? Propose légende, hashtags, recadrage et améliorations concrètes.
${contexte ? `Contexte donné par l'utilisateur : ${contexte}` : ""}

${profile(brand)}`,
      },
    ],
  );
}

// ---------- Publicité ----------

export async function adsGenerator({ produit, objectif, plateformes, budget, audience }, brand) {
  return structured(
    schemas.AdPack,
    `Crée une campagne publicitaire prête à lancer.
Produit ou offre : ${produit}
Objectif : ${objectif || "ventes"}
Plateformes : ${(plateformes?.length ? plateformes : ["Meta Ads"]).join(", ")}
Budget : ${budget || "non précisé : propose un budget de test raisonnable"}
Audience connue : ${audience || "à définir"}

Pour chaque plateforme, écris 3 variantes (A, B, C) qui testent chacune un angle différent.
Google Ads : titres de 30 caractères maximum, descriptions de 90 caractères maximum. Respecte les règles de la marque et les règles publicitaires des plateformes (pas de promesse trompeuse).

${profile(brand)}
<statistiques>${json(await sources.stats(brand))}</statistiques>
<resultats_publicitaires_recents>${json(await sources.ads(brand))}</resultats_publicitaires_recents>`,
    "high",
  );
}

export async function adsReview(brand) {
  return structured(
    schemas.AdsReview,
    `Analyse les performances publicitaires de la semaine comme une media buyer senior. Pour chaque annonce, décide : couper, augmenter le budget, garder ou retravailler, en t'appuyant sur le CTR, le CPC, les conversions et le ROAS, et sur les objectifs de la marque. Signale les alertes (budget gaspillé, fatigue publicitaire) et propose les prochains tests.

${profile(brand)}
<resultats>${json(await sources.ads(brand))}</resultats>`,
  );
}

// ---------- Veille ----------

// Deux temps : une recherche web libre, puis une mise en forme structurée.
export async function veille(brand) {
  const p = store.read("profile", brand);
  const messages = [{
    role: "user",
    content: `Fais une veille web récente pour la marque « ${p.marque} » (${p.activite}).
Cherche : les mentions récentes de la marque et l'avis des gens, l'actualité de ces concurrents : ${(p.concurrents || []).join(", ") || "à identifier"}, et les tendances de contenu de la niche (${p.niche}).
Mots-clés suivis : ${(p.mots_cles_veille || []).join(", ")}.
Résume ce que tu trouves avec les sources (URL).`,
  }];
  let notes = "";
  for (let i = 0; i < 4; i++) {
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: "medium" },
      tools: [WEB_SEARCH],
      messages,
      ...FALLBACK,
    });
    notes += response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }
  const result = await structured(
    schemas.Veille,
    `Mets en forme cette veille pour la marque. N'invente rien : uniquement ce qui figure dans les notes, avec les URL données (chaîne vide sinon).

${profile(brand)}
<notes_de_veille>${notes}</notes_de_veille>`,
  );
  store.write("veille", { ...result, mise_a_jour: new Date().toISOString() }, brand);
  return result;
}

// ---------- Rapport client ----------

export async function reportInsights(data, brand) {
  return structured(
    schemas.ReportInsights,
    `Rédige l'analyse du rapport de performance destiné au client de la marque. Ton professionnel, chiffré, pédagogique : le client n'est pas un expert. Mets en avant les résultats, explique les points faibles sans les cacher, et termine par des recommandations concrètes.

${profile(brand)}
<donnees_du_rapport>${json(data)}</donnees_du_rapport>`,
  );
}

// ---------- Agent conversationnel avec outils ----------

function makeTools(brand) {
  return [
    betaZodTool({
      name: "lire_emails",
      description: "Lit la boîte de réception de l'utilisateur (expéditeur, objet, corps).",
      inputSchema: z.object({}),
      run: async () => json(await sources.inbox()),
    }),
    betaZodTool({
      name: "lire_communaute",
      description: "Lit les derniers commentaires, messages privés et avis de la marque active.",
      inputSchema: z.object({}),
      run: async () => json(await sources.community(brand)),
    }),
    betaZodTool({
      name: "lire_statistiques",
      description: "Lit les statistiques des 7 derniers jours de la marque active, par plateforme.",
      inputSchema: z.object({}),
      run: async () => json(await sources.stats(brand)),
    }),
    betaZodTool({
      name: "lire_publicite",
      description: "Lit les performances des annonces publicitaires de la marque active (dépense, CTR, CPC, conversions, ROAS).",
      inputSchema: z.object({}),
      run: async () => json(await sources.ads(brand)),
    }),
    betaZodTool({
      name: "lire_agenda",
      description: "Lit l'agenda du jour de l'utilisateur.",
      inputSchema: z.object({}),
      run: async () => json(await sources.agenda()),
    }),
    betaZodTool({
      name: "lire_calendrier_editorial",
      description: "Lit le calendrier éditorial de la marque active (contenus, statuts de validation et de publication).",
      inputSchema: z.object({}),
      run: async () => json(sources.calendar(brand)),
    }),
    betaZodTool({
      name: "planifier_contenu",
      description: "Ajoute un contenu au calendrier éditorial de la marque active, au statut « idée ». Il ne sera jamais publié sans validation.",
      inputSchema: z.object({
        date: z.string().describe("Date AAAA-MM-JJ"),
        heure: z.string().describe("Heure HH:MM"),
        plateforme: z.string(),
        format: z.string(),
        sujet: z.string(),
        legende: z.string(),
      }),
      run: async (input) => json(store.append("calendar", { ...input, image_url: "", statut: "idée" }, brand)),
    }),
    betaZodTool({
      name: "preparer_brouillon",
      description: "Enregistre un brouillon de mail ou de réponse dans la boîte d'envoi. Rien n'est envoyé : l'utilisateur valide lui-même.",
      inputSchema: z.object({
        canal: z.string().describe("email, Instagram, TikTok, Google..."),
        destinataire: z.string(),
        objet: z.string(),
        texte: z.string(),
      }),
      run: async (input) => json(store.append("drafts", { ...input, marque: brand, cree: new Date().toISOString() })),
    }),
    betaZodTool({
      name: "memoriser",
      description: "Retient durablement une préférence, une décision ou une information sur la marque active ou sur l'utilisateur.",
      inputSchema: z.object({ note: z.string() }),
      run: async ({ note }) => json(store.append("notes", { note, date: new Date().toISOString() }, brand)),
    }),
    WEB_SEARCH,
  ];
}

const conversations = new Map();

export async function chat({ conversationId, message }, brand) {
  const key = `${brand}:${conversationId}`;
  const history = conversations.get(key) ?? [];
  const content = history.length
    ? message
    : `${profile(brand)}\n<memoire>${json(store.read("notes", brand))}</memoire>\nDate : ${today()}.\n\n${message}`;

  const runner = getClient().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: "medium" },
    tools: makeTools(brand),
    max_iterations: 12,
    messages: [...history, { role: "user", content }],
    ...FALLBACK,
  });

  const used = [];
  for await (const msg of runner) {
    for (const block of msg.content) {
      if (block.type === "tool_use" || block.type === "server_tool_use") used.push(block.name);
    }
  }
  const final = await runner.done();
  conversations.set(key, [...runner.params.messages]);

  if (final.stop_reason === "refusal") {
    return { texte: "Je préfère ne pas traiter cette demande, Boss. Reformulons autrement ?", outils: used };
  }
  const texte = final.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return { texte, outils: [...new Set(used)] };
}

export function resetConversation(conversationId, brand) {
  conversations.delete(`${brand}:${conversationId}`);
}
