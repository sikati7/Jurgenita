// Formats de sortie structurés (JSON garanti par l'API).
import { z } from "zod";

export const Briefing = z.object({
  salutation: z.string().describe("Une phrase d'accueil personnalisée pour le réveil"),
  a_dire: z.string().describe("Résumé oral du briefing, lu à voix haute"),
  priorites: z.array(z.object({
    titre: z.string(),
    pourquoi: z.string(),
    action: z.string(),
  })).describe("Les 3 à 5 choses les plus importantes du jour, dans l'ordre"),
  emails: z.array(z.object({
    id: z.string(),
    categorie: z.enum(["urgent", "a_repondre", "opportunite", "a_deleguer", "a_ignorer"]),
    resume: z.string(),
    recommandation: z.string().describe("Ce qu'il faut faire et pourquoi"),
    repondre: z.boolean(),
    brouillon: z.string().describe("Brouillon de réponse complet, ou chaîne vide si on ne répond pas"),
  })),
  communaute: z.object({
    humeur: z.string().describe("Le climat général de la communauté en une phrase"),
    alertes: z.array(z.string()),
    reponses: z.array(z.object({
      id: z.string(),
      reponse: z.string(),
      moderation: z.enum(["aucune", "masquer", "signaler", "passer_en_prive"]),
    })),
  }),
  idees_contenu: z.array(z.object({
    plateforme: z.string(),
    format: z.string(),
    accroche: z.string(),
    idee: z.string(),
  })),
  conseil_du_jour: z.string(),
});

export const EmailReply = z.object({
  objet: z.string(),
  corps: z.string(),
  notes: z.string().describe("Conseils de négociation ou points d'attention pour l'utilisateur"),
});

export const ContentPack = z.object({
  concept: z.string(),
  posts: z.array(z.object({
    plateforme: z.string(),
    format: z.string(),
    accroche: z.string().describe("Les 2 premières secondes ou la première ligne"),
    legende: z.string(),
    hashtags: z.array(z.string()),
    direction_visuelle: z.string(),
    meilleur_moment: z.string(),
    appel_a_l_action: z.string(),
  })),
  script_video: z.array(z.object({
    temps: z.string().describe("ex. 0-3 s"),
    plan: z.string(),
    voix_off: z.string(),
    texte_ecran: z.string(),
  })),
  conseils: z.array(z.string()),
});

export const CommunityTriage = z.object({
  synthese: z.string(),
  elements: z.array(z.object({
    id: z.string(),
    sentiment: z.enum(["positif", "neutre", "negatif", "spam"]),
    priorite: z.enum(["haute", "moyenne", "basse"]),
    categorie: z.string().describe("ex. question, compliment, critique, opportunité, troll, spam"),
    reponse: z.string().describe("Réponse publique ou privée proposée, ou chaîne vide"),
    moderation: z.enum(["aucune", "masquer", "signaler", "passer_en_prive"]),
    raison: z.string(),
  })),
  idees_issues_de_la_communaute: z.array(z.string()),
});
