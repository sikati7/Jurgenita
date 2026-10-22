// Mode démo : réponses préparées à partir des données locales, pour essayer
// Jurgenita sans clé API. Le mode réel (src/claude.js) remplace tout ceci.
import * as store from "./store.js";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function briefing() {
  await pause(900);
  const p = store.read("profile");
  const s = store.read("stats");
  const insta = s.plateformes.Instagram;
  return {
    salutation: `Bonjour ${p.appellation}. Café chaud, cerveau en ligne : voici votre journée.`,
    a_dire: `Bonjour ${p.appellation}. Trois urgences ce matin. Un client mécontent menace de laisser un avis Google : je vous ai préparé une réponse d'excuse avec un geste commercial. Épices du Monde propose un partenariat à six cents euros, on contre-propose à huit cents, c'est votre tarif Reel. Et Awa Diallo veut un duel vidéo, c'est une très belle opportunité. J'ignore la newsletter et je décline le whisky, conformément à vos règles. Côté réseaux, TikTok explose, et une maman demande si le mafé contient des arachides : à traiter en priorité. Tournage à neuf heures trente.`,
    priorites: [
      { titre: "Désamorcer le mécontentement de Marc Duval", pourquoi: "Il hésite à publier un avis Google : un 1 étoile pèse lourd sur une note de 4,4.", action: "Envoyer le brouillon d'excuse avec l'invitation à revenir (dessert offert)." },
      { titre: "Répondre à la question d'allergie de @lea.martin", pourquoi: "Sécurité alimentaire : réponse précise obligatoire avant vendredi.", action: "Confirmer en DM que le mafé contient de l'arachide et proposer une alternative." },
      { titre: "Négocier le partenariat Épices du Monde", pourquoi: "600 € pour 1 Reel + 3 stories, sous votre prix plancher de 800 € pour un Reel.", action: "Envoyer le media kit et contre-proposer 950 € le pack." },
      { titre: "Dire oui à la collab Awa Diallo", pourquoi: "180k abonnés TikTok dans une niche voisine : idéal pour l'objectif 50k Instagram.", action: "Proposer deux dates début novembre, tournage un mardi pour remplir la salle." },
      { titre: "Réussir le tournage de 9h30", pourquoi: "« Les secrets de Maman » est votre format le plus viral (410k vues sur le #3).", action: "Tourner aussi 3 plans verticaux bonus pour les stories." },
    ],
    emails: [
      { id: "m2", categorie: "urgent", resume: "Client déçu (attente de 50 min, plat tiède), menace un avis Google.", recommandation: "Répondre ce matin, s'excuser sans se justifier, offrir un geste. Un client reconquis devient souvent ambassadeur.", repondre: true, brouillon: "Bonjour Monsieur Duval,\n\nMerci d'avoir pris le temps de nous écrire, et toutes nos excuses pour votre soirée de samedi. Cinquante minutes d'attente et un poulet DG tiède, ce n'est pas l'expérience que nous voulons offrir, surtout à une table de six.\n\nNous avons revu notre organisation en cuisine pour les grandes tablées du week-end. Nous serions très heureux de vous accueillir à nouveau : le dessert et les boissons chaudes seront offerts à toute votre table. Il suffit de répondre à ce mail pour réserver.\n\nBien chaleureusement,\nJean — Resto-Afrik" },
      { id: "m1", categorie: "opportunite", resume: "Épices du Monde : 1 Reel + 3 stories pour 600 €, demande le media kit.", recommandation: "Accepter le principe, contre-proposer 950 € (Reel 800 € + stories). Marque très alignée avec la niche.", repondre: true, brouillon: "Bonjour Clara,\n\nMerci pour votre message, votre nouvelle gamme colle parfaitement à notre univers : le suya et le poivre de Penja sont déjà dans nos cuisines !\n\nVous trouverez notre media kit en pièce jointe. Sur les 7 derniers jours, nos Reels ont touché plus de 214 000 personnes sur Instagram avec un taux d'engagement de 5,8 %. Pour 1 Reel et 3 stories, notre tarif est de 950 € HT, création et tournage en cuisine compris.\n\nJe vous propose un appel cette semaine pour caler le concept.\n\nBien à vous,\nJean — Resto-Afrik" },
      { id: "m4", categorie: "opportunite", resume: "Awa Diallo (180k TikTok) propose un duel thieb vs ndolé au resto.", recommandation: "Oui sans hésiter : audience complémentaire, format compétitif très partageable.", repondre: true, brouillon: "Hello Awa !\n\nCarrément partant 🔥 Le duel thieb vs ndolé, on en parle déjà en cuisine. Je te propose le mardi 4 ou le mardi 11 novembre, en fin d'après-midi au resto. On fait voter nos communautés en commentaires ?\n\nDis-moi ce qui t'arrange !\nJean" },
      { id: "m6", categorie: "a_repondre", resume: "Journaliste du Bon Guide : interview de 20 min + photos HD pour un dossier du 15 novembre.", recommandation: "Accepter : visibilité presse gratuite. Proposer jeudi 15h et envoyer 5 photos HD.", repondre: true, brouillon: "Bonjour Madame Laurent,\n\nAvec plaisir ! Je suis disponible jeudi à 15h ou vendredi à 10h pour un échange téléphonique. Je vous envoie dès aujourd'hui une sélection de photos HD de nos plats signature.\n\nBien cordialement,\nJean — Resto-Afrik" },
      { id: "m8", categorie: "a_repondre", resume: "Stand gratuit au Festival des saveurs du 11e (8 novembre), réponse avant le 28 octobre.", recommandation: "Accepter : excellent pour le contenu et la clientèle locale. Prévoir un live depuis le stand.", repondre: true, brouillon: "Madame, Monsieur,\n\nNous acceptons avec plaisir votre invitation au Festival des saveurs du samedi 8 novembre. Pourriez-vous nous indiquer les dimensions du stand et les modalités d'accès à l'électricité ?\n\nCordialement,\nJean — Resto-Afrik" },
      { id: "m5", categorie: "a_deleguer", resume: "Relance d'une facture impayée de 342,80 € (Fournil Paris).", recommandation: "Transmettre à la comptabilité et payer cette semaine pour préserver la relation fournisseur.", repondre: false, brouillon: "" },
      { id: "m7", categorie: "a_ignorer", resume: "Kronen Spirits : 2 500 € pour promouvoir un whisky.", recommandation: "Décliner poliment : vos règles excluent les alcools forts.", repondre: true, brouillon: "Bonjour,\n\nMerci pour votre proposition. Nous ne collaborons pas avec des marques d'alcool fort, nous déclinons donc. Belle continuation !\n\nJean — Resto-Afrik" },
      { id: "m3", categorie: "a_ignorer", resume: "Newsletter promotionnelle d'une formation à 997 €.", recommandation: "Ignorer et se désabonner.", repondre: false, brouillon: "" },
    ],
    communaute: {
      humeur: `Très positive : +${insta.evolution_abonnes} abonnés Instagram et +2 340 sur TikTok cette semaine. Deux points de vigilance : le service lent revient dans les avis.`,
      alertes: [
        "Question d'allergie à l'arachide (@lea.martin) : répondre avant vendredi.",
        "La lenteur du service est citée dans 2 retours en 3 jours (mail de Marc Duval et avis Google de Thomas R.).",
        "Spam crypto sous « Les secrets de Maman #3 » sur TikTok.",
      ],
      reponses: [
        { id: "c3", reponse: "Bonjour Léa ! Oui, notre mafé est préparé à la pâte d'arachide, donc à éviter pour votre fils. Je vous recommande le poulet DG ou le ndolé sans arachide (préparé à part sur demande). Prévenez-nous à la réservation et la cuisine prendra toutes les précautions 🙏", moderation: "aucune" },
        { id: "c1", reponse: "Ça, c'est le plus beau compliment pour Maman 😭❤️ On livre à Montreuil via Uber Eats et Deliveroo, 7j/7 !", moderation: "aucune" },
        { id: "c6", reponse: "Oui ! On privatise la salle jusqu'à 30 personnes avec un menu sur mesure. Envoie-nous un DM avec la date et on te prépare un devis 🎉", moderation: "aucune" },
        { id: "c8", reponse: "Merci Thomas pour ce retour honnête. Vous avez raison sur l'attente, nous renforçons l'équipe le week-end et baissons le son en salle. Revenez nous voir, on aimerait vous faire changer d'avis !", moderation: "aucune" },
        { id: "c2", reponse: "Plats à partir de 13 € et la recette de Maman en bonus gratuit sur ce compte 😉 Viens goûter, le premier jus de bissap est pour nous.", moderation: "aucune" },
        { id: "c5", reponse: "", moderation: "masquer" },
      ],
    },
    idees_contenu: [
      { plateforme: "TikTok", format: "Vidéo 30 s", accroche: "« Il a dit que c'était un resto pour bobos… »", idee: "Répondre en vidéo au commentaire de @kev_le_vrai en montrant les prix et l'origine des produits. Les réponses aux critiques génèrent beaucoup de commentaires." },
      { plateforme: "YouTube Shorts + Reel", format: "Recette", accroche: "« Le plat dont personne ne parle jamais : le koki »", idee: "Demandé par Mireille K. : remerciez-la à l'écran, la communauté adore être écoutée." },
      { plateforme: "Instagram", format: "Story sondage", accroche: "« Thieb ou ndolé ? Votez ! »", idee: "Teaser de la collab avec Awa avant même l'annonce, pour mesurer l'enthousiasme." },
    ],
    conseil_du_jour: `Le mardi soir est votre point faible (${s.restaurant.mardi} couverts). Publiez à 12h une offre « Mardi des racines » visible uniquement par vos abonnés : c'est une raison de s'abonner ET de venir.`,
  };
}

export async function emailReply({ id, intention }) {
  await pause(600);
  const email = store.read("inbox").find((m) => m.id === id);
  if (!email) throw new Error(`Email ${id} introuvable`);
  const base = (await briefing()).emails.find((e) => e.id === id);
  const prenom = email.de.split(" ")[0];
  return {
    objet: `Re: ${email.objet}`,
    corps: base?.brouillon || `Bonjour ${prenom},\n\nMerci pour votre message. ${intention ? `(${intention}) ` : ""}Je reviens vers vous très rapidement.\n\nBien à vous,\nJean — Resto-Afrik`,
    notes: intention ? `Mode démo : l'intention « ${intention} » sera vraiment prise en compte avec une clé API.` : (base?.recommandation || "Rien de particulier."),
  };
}

export async function contentStudio({ sujet, plateformes }) {
  await pause(800);
  const list = plateformes?.length ? plateformes : ["Instagram", "TikTok"];
  const s = store.read("stats");
  return {
    concept: `« ${sujet} » raconté comme un secret de famille : on montre le geste, on raconte l'histoire, on finit sur la dégustation.`,
    posts: list.map((plateforme) => ({
      plateforme,
      format: plateforme === "LinkedIn" ? "Post texte + photo" : plateforme === "Facebook" ? "Vidéo carrée" : "Vidéo verticale 30-45 s",
      accroche: plateforme === "LinkedIn" ? `Ce que « ${sujet} » m'a appris sur l'entrepreneuriat.` : `Personne ne fait « ${sujet} » comme ça… sauf Maman.`,
      legende: plateforme === "LinkedIn"
        ? `Derrière chaque plat de Resto-Afrik, il y a une transmission. Aujourd'hui : ${sujet}. Voici ce que cette recette dit de notre façon de travailler 👇`
        : `${sujet} 🔥 La recette qu'on se transmet depuis trois générations. Tu l'as déjà goûté ? Dis-nous en commentaire comment on le prépare chez toi 👇`,
      hashtags: ["#cuisineafricaine", "#restoafrik", "#foodparis", "#recettedefamille", "#afrofood"],
      direction_visuelle: "Lumière chaude, gros plans sur les mains et la vapeur, couleurs vives du wax en arrière-plan.",
      meilleur_moment: s.heures_fortes[plateforme] || "18h-21h",
      appel_a_l_action: plateforme === "LinkedIn" ? "Partagez la recette qui vous relie à vos racines." : "Enregistre pour plus tard et tague quelqu'un qui doit goûter ça.",
    })),
    script_video: [
      { temps: "0-3 s", plan: "Gros plan sur la marmite qui fume", voix_off: "Personne ne fait ça comme Maman.", texte_ecran: "LE SECRET 🤫" },
      { temps: "3-12 s", plan: "Les ingrédients posés un à un, vue du dessus", voix_off: "Trois ingrédients que tu as sûrement dans ta cuisine…", texte_ecran: "Ingrédient n°3 = la clé" },
      { temps: "12-28 s", plan: "Les gestes de Maman en plans rapides", voix_off: "Et le geste que personne ne te montre jamais.", texte_ecran: "Regarde bien ses mains 👀" },
      { temps: "28-38 s", plan: "Dégustation, réaction sincère", voix_off: "Voilà. Maintenant tu sais.", texte_ecran: "Recette complète en commentaire" },
    ],
    conseils: [
      "Mode démo : connectez une clé API pour un pack vraiment sur mesure.",
      `Votre format le plus fort reste « Les secrets de Maman » (${s.plateformes.TikTok.meilleur_post}).`,
      "Épinglez un commentaire avec la recette pour multiplier les enregistrements.",
    ],
  };
}

export async function communityTriage() {
  await pause(700);
  const b = await briefing();
  const items = store.read("community");
  const meta = {
    c1: ["positif", "moyenne", "compliment + question livraison", "aucune", "Fidélisation et vente en livraison."],
    c2: ["negatif", "moyenne", "troll / critique prix", "aucune", "Répondre avec humour transforme la critique en visibilité."],
    c3: ["neutre", "haute", "question allergie", "aucune", "Sécurité alimentaire, réponse précise obligatoire."],
    c4: ["positif", "basse", "compliment", "aucune", "Un simple merci et un cœur suffisent."],
    c5: ["spam", "basse", "spam", "masquer", "Arnaque crypto, à masquer et bloquer."],
    c6: ["positif", "haute", "opportunité privatisation", "passer_en_prive", "Vente potentielle de 20 couverts."],
    c7: ["positif", "moyenne", "demande de contenu", "aucune", "Idée de vidéo offerte par la communauté."],
    c8: ["negatif", "haute", "avis négatif", "aucune", "Les avis Google influencent directement les réservations."],
  };
  return {
    synthese: b.communaute.humeur,
    elements: items.map((c) => {
      const [sentiment, priorite, categorie, moderation, raison] = meta[c.id] || ["neutre", "basse", "autre", "aucune", ""];
      const rep = b.communaute.reponses.find((r) => r.id === c.id);
      return {
        id: c.id, sentiment, priorite, categorie, moderation, raison,
        reponse: rep?.reponse ?? (c.id === "c4" ? "Merci Pascal, ça nous touche ! À très vite 🔥" : c.id === "c7" ? "Excellente idée Mireille ! Le koki arrive bientôt, on te tague dans la vidéo 😍" : ""),
      };
    }),
    idees_issues_de_la_communaute: [
      "Une vidéo sur le koki (demandée par Mireille K.)",
      "Une story « Allergènes : on vous dit tout » pour rassurer les familles",
      "Un Reel « Combien coûte vraiment un repas chez nous ? » en réponse aux critiques sur les prix",
    ],
  };
}

// Petite base de connaissances pour répondre aux questions d'expertise en démo.
const KNOWLEDGE = [
  { mots: ["heure", "moment", "quand publier", "horaire"], texte: () => {
    const h = store.read("stats").heures_fortes;
    return `D'après vos statistiques, Boss : Instagram ${h.Instagram}, TikTok ${h.TikTok}, Facebook ${h.Facebook}, LinkedIn ${h.LinkedIn}. Publiez 30 minutes avant le pic pour laisser l'algorithme tester la vidéo, et restez disponible 20 minutes après pour répondre aux premiers commentaires : c'est là que se joue la portée.`;
  } },
  { mots: ["engagement", "taux"], texte: () => {
    const p = store.read("stats").plateformes;
    return `Le taux d'engagement, c'est (likes + commentaires + partages + enregistrements) divisé par la portée ou le nombre d'abonnés. Vous êtes à ${p.Instagram.taux_engagement} % sur Instagram et ${p.TikTok.taux_engagement} % sur TikTok : au-dessus de la moyenne food, qui tourne autour de 2 à 4 % sur Instagram. Pour progresser : des questions ouvertes en fin de légende, et des formats qui donnent envie d'enregistrer, comme les recettes.`;
  } },
  { mots: ["bad buzz", "crise", "avis négatif", "critique", "négatif"], texte: () => "Ma méthode en 4 temps : 1. Répondre vite, en moins de 24 h, publiquement et brièvement. 2. Reconnaître sans se justifier ni contre-attaquer. 3. Passer en privé pour régler le cas concret. 4. Montrer publiquement ce qui a changé, par exemple en coulisses. Ne supprimez jamais une critique légitime : seuls les spams et les insultes se masquent." },
  { mots: ["hashtag"], texte: () => "En 2026, les hashtags servent surtout à catégoriser votre contenu, pas à le pousser. Comptez 3 à 5 hashtags précis (#cuisineafricaine, #foodparis, #restoafrik) plutôt que 30 génériques. Sur TikTok et Instagram, les mots-clés dans la légende et le texte à l'écran comptent désormais davantage pour la recherche." },
  { mots: ["algorithme", "algo", "portée"], texte: () => "Les algorithmes récompensent la rétention : la part des gens qui regardent jusqu'au bout et qui revoient. Une accroche forte dans les 2 premières secondes, un rythme serré, et une fin qui reboucle sur le début. Les partages en message privé et les enregistrements pèsent plus que les likes." },
  { mots: ["calendrier", "planning", "planifier"], texte: () => {
    const cal = store.read("calendar");
    return `Votre calendrier compte ${cal.length} contenus planifiés. Je vous conseille un rythme 3-2-1 par semaine : 3 vidéos courtes, 2 carrousels ou photos, 1 format long ou un live. Gardez « Les secrets de Maman » le même jour à la même heure pour créer un rendez-vous.`;
  } },
  { mots: ["prix", "tarif", "combien facturer", "négocier", "partenariat"], texte: () => {
    const r = store.read("profile").regles.join(" ; ");
    return `Vos règles : ${r}. Repère courant pour un micro-influenceur food : 100 à 200 € par tranche de 10 000 abonnés pour un post, davantage pour la vidéo et l'usage publicitaire. Ne baissez jamais votre prix : ajoutez ou retirez des livrables à la place.`;
  } },
  { mots: ["mail", "email", "courrier", "boîte"], texte: () => {
    const n = store.read("inbox").length;
    return `Vous avez ${n} emails. Les urgences : Marc Duval, client mécontent, et deux opportunités en or, Épices du Monde et Awa Diallo. Ouvrez l'onglet « Boîte mail » pour voir mes brouillons, ou dites « Briefing » pour le tour complet.`;
  } },
  { mots: ["stat", "chiffre", "performance", "abonné"], texte: () => {
    const p = store.read("stats").plateformes;
    return `Sur 7 jours : Instagram ${p.Instagram.abonnes.toLocaleString("fr-FR")} abonnés (+${p.Instagram.evolution_abonnes}), TikTok ${p.TikTok.abonnes.toLocaleString("fr-FR")} (+${p.TikTok.evolution_abonnes}). Votre meilleur contenu : ${p.TikTok.meilleur_post}. Au rythme actuel, l'objectif de 50 000 abonnés Instagram sera atteint dans environ 13 semaines : une collab comme celle d'Awa peut le rapprocher nettement.`;
  } },
  { mots: ["idée", "inspiration", "contenu", "quoi poster"], texte: () => "Trois idées pour aujourd'hui : 1. Répondre en vidéo au troll qui trouve le resto « pour bobos », en montrant les prix. 2. Le koki, demandé par votre communauté. 3. Un sondage « Thieb ou ndolé ? » en teaser de la collab avec Awa. Le Studio peut transformer n'importe laquelle en pack complet." },
];

export async function chat({ message }) {
  await pause(500);
  const m = message.toLowerCase();
  const hit = KNOWLEDGE.find((k) => k.mots.some((w) => m.includes(w)));
  if (/bonjour|salut|hello|réveil|coucou/.test(m) && !hit) {
    return { texte: "Bonjour Boss. Je suis en ligne. Dites « Briefing » pour le tour du matin, ou posez-moi n'importe quelle question de contenu ou de communauté.", outils: [] };
  }
  if (hit) return { texte: hit.texte(), outils: ["mode démo"] };
  return {
    texte: "En mode démo, je réponds aux sujets suivants : horaires de publication, engagement, bad buzz, hashtags, algorithmes, calendrier, tarifs de partenariat, mails, statistiques et idées. Ajoutez une clé API Anthropic pour que je réponde vraiment à tout, que je cherche les tendances sur le web, et que je retienne vos préférences.",
    outils: ["mode démo"],
  };
}

export function resetConversation() {}
