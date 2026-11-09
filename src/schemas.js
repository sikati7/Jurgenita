// Formats de sortie structurés (JSON garanti par l'API).
// Le SDK ne transmet pas les listes de valeurs (enum) comme contrainte stricte,
// seulement comme indication : chaque liste a donc une valeur de repli (.catch),
// pour qu'une valeur inattendue ne fasse pas échouer toute la réponse.
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
    categorie: z.enum(["urgent", "a_repondre", "opportunite", "a_deleguer", "a_ignorer"]).catch("a_repondre"),
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
      moderation: z.enum(["aucune", "masquer", "signaler", "passer_en_prive"]).catch("aucune"),
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
    sentiment: z.enum(["positif", "neutre", "negatif", "spam"]).catch("neutre"),
    priorite: z.enum(["haute", "moyenne", "basse"]).catch("moyenne"),
    categorie: z.string().describe("ex. question, compliment, critique, opportunité, troll, spam"),
    reponse: z.string().describe("Réponse publique ou privée proposée, ou chaîne vide"),
    moderation: z.enum(["aucune", "masquer", "signaler", "passer_en_prive"]).catch("aucune"),
    raison: z.string(),
  })),
  idees_issues_de_la_communaute: z.array(z.string()),
});

export const VisionReport = z.object({
  description: z.string().describe("Ce que l'on voit, en une ou deux phrases"),
  note_accroche: z.number().describe("Note de 0 à 10 : capacité à arrêter le scroll"),
  verdict: z.string().describe("Avis franc en une phrase"),
  points_forts: z.array(z.string()),
  a_ameliorer: z.array(z.string()),
  recadrage: z.string().describe("Format conseillé (9:16, 4:5, 1:1) et comment recadrer"),
  plateforme_ideale: z.string(),
  legende: z.string(),
  hashtags: z.array(z.string()),
  idee_de_montage: z.string().describe("Comment en faire une vidéo ou un carrousel plus fort"),
});

export const AdPack = z.object({
  strategie: z.string().describe("L'angle de la campagne en deux phrases"),
  audiences: z.array(z.object({
    nom: z.string(),
    ciblage: z.string().describe("Âge, zone, centres d'intérêt, audiences similaires…"),
    pourquoi: z.string(),
  })),
  annonces: z.array(z.object({
    plateforme: z.enum(["Meta Ads", "Google Ads", "TikTok Ads"]).catch("Meta Ads"),
    variante: z.string().describe("A, B, C…"),
    angle: z.string().describe("Le levier testé : prix, émotion, preuve sociale, urgence…"),
    titre: z.string().describe("Google Ads : 30 caractères maximum"),
    texte_principal: z.string(),
    description: z.string().describe("Google Ads : 90 caractères maximum"),
    appel_a_l_action: z.string(),
    visuel: z.string().describe("Brief créatif du visuel ou de la vidéo"),
  })),
  test_ab: z.string().describe("Comment tester les variantes et quand décider"),
  repartition_budget: z.string(),
  kpi_a_suivre: z.array(z.string()),
});

export const AdsReview = z.object({
  synthese: z.string(),
  decisions: z.array(z.object({
    annonce: z.string(),
    decision: z.enum(["couper", "augmenter", "garder", "retravailler"]).catch("garder"),
    raison: z.string(),
  })),
  alertes: z.array(z.string()),
  prochains_tests: z.array(z.string()),
});

export const Veille = z.object({
  mentions: z.array(z.object({
    source: z.string(),
    titre: z.string(),
    sentiment: z.enum(["positif", "neutre", "negatif"]).catch("neutre"),
    url: z.string(),
  })),
  concurrents: z.array(z.object({ nom: z.string(), activite: z.string() })),
  tendances: z.array(z.string()),
  alerte: z.string().describe("Risque de bad buzz à traiter tout de suite, ou chaîne vide"),
  opportunites: z.array(z.string()),
});

export const ReportInsights = z.object({
  resume: z.string().describe("Le mois en trois phrases, pour le client"),
  reussites: z.array(z.string()),
  points_attention: z.array(z.string()),
  recommandations: z.array(z.string()),
  objectifs_prochaine_periode: z.array(z.string()),
});
