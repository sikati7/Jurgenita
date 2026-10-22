// Appels à Claude : sorties structurées pour les modules (briefing, mails,
// studio, communauté) et un agent avec outils pour la conversation libre.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import * as store from "./store.js";
import { PERSONA, VOICE_HINT } from "./prompts.js";
import * as schemas from "./schemas.js";

export const MODEL = process.env.JURGENITA_MODEL || "claude-opus-5-5";

// En cas de refus d'un classifieur de sécurité, l'API relance la requête sur
// le modèle de repli recommandé au lieu de renvoyer un refus.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

const SYSTEM = [{ type: "text", text: PERSONA, cache_control: { type: "ephemeral" } }];

let client;
function getClient() {
  client ??= new Anthropic();
  return client;
}

function today() {
  return new Date().toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Paris" });
}

export class RefusalError extends Error {}

async function structured(schema, prompt, effort = "medium") {
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort, format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content: prompt }],
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

export function briefing() {
  const ctx = store.snapshot();
  return structured(
    schemas.Briefing,
    `Nous sommes le ${today()}. C'est l'heure du réveil : prépare le briefing du matin.

Trie chaque email (urgent, à répondre, opportunité, à déléguer, à ignorer), dis s'il faut répondre et rédige le brouillon quand c'est le cas.
Pour la communauté, propose une réponse à chaque élément qui le mérite et la modération adaptée.
Propose 3 idées de contenu inspirées des statistiques, de la communauté et de l'agenda.
${VOICE_HINT}

<contexte>
${json(ctx)}
</contexte>`,
    "high",
  );
}

export function emailReply({ id, intention }) {
  const email = store.read("inbox").find((m) => m.id === id);
  if (!email) throw new Error(`Email ${id} introuvable`);
  return structured(
    schemas.EmailReply,
    `Rédige la réponse à cet email.
Intention de l'utilisateur : ${intention || "à toi de choisir la meilleure réponse"}

<profil>${json(store.read("profile"))}</profil>
<statistiques>${json(store.read("stats"))}</statistiques>
<email>${json(email)}</email>`,
  );
}

export function contentStudio({ sujet, plateformes, objectif }) {
  return structured(
    schemas.ContentPack,
    `Crée un pack de contenu complet.
Sujet : ${sujet}
Plateformes : ${(plateformes?.length ? plateformes : ["Instagram", "TikTok"]).join(", ")}
Objectif : ${objectif || "engagement et nouveaux abonnés"}

Pour chaque plateforme, adapte le format, l'accroche et la légende à ses codes. Le script vidéo doit tenir en 30 à 45 secondes.

<profil>${json(store.read("profile"))}</profil>
<statistiques>${json(store.read("stats"))}</statistiques>`,
  );
}

export function communityTriage() {
  return structured(
    schemas.CommunityTriage,
    `Analyse les interactions récentes de la communauté, propose une réponse pour chacune et la modération adaptée. Repère aussi les idées de contenu qu'elles inspirent.

<profil>${json(store.read("profile"))}</profil>
<interactions>${json(store.read("community"))}</interactions>`,
  );
}

// ---------- Agent conversationnel avec outils ----------

const tools = [
  betaZodTool({
    name: "lire_emails",
    description: "Lit la boîte de réception de l'utilisateur (expéditeur, objet, corps).",
    inputSchema: z.object({}),
    run: async () => json(store.read("inbox")),
  }),
  betaZodTool({
    name: "lire_communaute",
    description: "Lit les derniers commentaires, DM et avis sur les réseaux sociaux et Google.",
    inputSchema: z.object({}),
    run: async () => json(store.read("community")),
  }),
  betaZodTool({
    name: "lire_statistiques",
    description: "Lit les statistiques des 7 derniers jours par plateforme et la fréquentation du restaurant.",
    inputSchema: z.object({}),
    run: async () => json(store.read("stats")),
  }),
  betaZodTool({
    name: "lire_agenda",
    description: "Lit l'agenda du jour.",
    inputSchema: z.object({}),
    run: async () => json(store.read("agenda")),
  }),
  betaZodTool({
    name: "lire_calendrier_editorial",
    description: "Lit le calendrier éditorial (contenus planifiés).",
    inputSchema: z.object({}),
    run: async () => json(store.read("calendar")),
  }),
  betaZodTool({
    name: "planifier_contenu",
    description: "Ajoute un contenu au calendrier éditorial.",
    inputSchema: z.object({
      date: z.string().describe("Date AAAA-MM-JJ"),
      plateforme: z.string(),
      format: z.string(),
      sujet: z.string(),
    }),
    run: async (input) => json(store.append("calendar", { ...input, statut: "idée" })),
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
    run: async (input) => json(store.append("drafts", { ...input, cree: new Date().toISOString() })),
  }),
  betaZodTool({
    name: "memoriser",
    description: "Retient durablement une préférence, une décision ou une information sur l'utilisateur ou sa marque.",
    inputSchema: z.object({ note: z.string() }),
    run: async ({ note }) => json(store.append("notes", { note, date: new Date().toISOString() })),
  }),
  { type: "web_search_20260209", name: "web_search", max_uses: 5 },
];

const conversations = new Map();

export async function chat({ conversationId, message }) {
  const history = conversations.get(conversationId) ?? [];
  const profile = store.read("profile");
  const notes = store.read("notes");
  const content = history.length
    ? message
    : `<profil>${json(profile)}</profil>\n<memoire>${json(notes)}</memoire>\nDate : ${today()}.\n\n${message}`;

  const runner = getClient().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: "medium" },
    tools,
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
  conversations.set(conversationId, [...runner.params.messages]);

  if (final.stop_reason === "refusal") {
    return { texte: "Je préfère ne pas traiter cette demande, Boss. Reformulons autrement ?", outils: used };
  }
  const texte = final.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return { texte, outils: [...new Set(used)] };
}

export function resetConversation(conversationId) {
  conversations.delete(conversationId);
}
