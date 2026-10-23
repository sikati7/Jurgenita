# ◉ J·U·R·G·E·N·I·T·A

**Jurgenita** est une assistante IA dans l'esprit de J.A.R.V.I.S., spécialisée dans la **création de contenu** et le **community management**.
Elle vous réveille, trie vos mails, prépare les réponses, surveille votre communauté, imagine vos contenus et répond à vos questions d'expertise, à la voix ou au clavier.

> Prototype. Les données de démo (mails, commentaires, stats) mettent en scène la marque **Resto-Afrik**.

## Démarrer en 30 secondes

```bash
cd jurgenita
npm install
npm start
```

Ouvrez **http://127.0.0.1:3000** dans Chrome ou Edge (pour la voix).

Sans clé API, Jurgenita tourne en **mode démo** : toutes les fonctions marchent avec des réponses préparées.
Pour la vraie intelligence et vos vrais comptes, copiez `.env.example` en `.env` et suivez **[CONNEXIONS.md](CONNEXIONS.md)** :

| Connexion | Ce que ça débloque |
|---|---|
| Clé API Anthropic | Le vrai cerveau (le badge passe de « Démo » à « En ligne ») |
| Gmail + Google Agenda | Vos vrais mails et votre agenda, brouillons créés directement dans Gmail |
| Instagram + Facebook | Vos vrais commentaires et abonnés, réponses publiées en un clic |
| Telegram | Briefing chaque matin sur le téléphone, et discussion avec Jurgenita depuis Telegram |

> Sous Windows, si PowerShell bloque `npm`, tapez `npm.cmd install` et `npm.cmd start`.

## Ce qu'elle sait faire

| Module | Ce que fait Jurgenita |
|---|---|
| ☀ **Réveil** | Briefing du matin lu à voix haute : priorités du jour, tri des mails, climat de la communauté, idées de contenu, conseil du jour. **Réveil automatique** à l'heure choisie (onglet ouvert). |
| ✉ **Boîte mail** | Classe chaque mail (urgent, à répondre, opportunité, à déléguer, à ignorer), dit s'il faut répondre et rédige le brouillon. Vous donnez une intention (« accepter mais à 900 € ») et elle réécrit. Aucun envoi automatique : copier, mettre en brouillon ou ouvrir dans votre messagerie. |
| ✦ **Studio** | Un sujet en entrée, un pack multi-plateformes en sortie : accroches, légendes, hashtags, direction visuelle, meilleur horaire, CTA et **script vidéo** seconde par seconde. Un clic pour planifier. **Analyse photo & vidéo** : déposez un visuel, Jurgenita note l'accroche sur 10 et propose légende, recadrage et idée de montage. |
| ◎ **Communauté** | Analyse les commentaires, DM et avis (sentiment, priorité, modération), propose une réponse dans le ton de la marque et repère les idées de contenu soufflées par les abonnés. |
| ▦ **Calendrier** | Calendrier éditorial sur 14 jours et file des brouillons en attente de validation. |
| ⟋ **Stats** | Abonnés, engagement, jours faibles du restaurant, note Google. |
| ⚙ **Profil** | Ton de marque, objectifs, règles (marques refusées, prix planchers) et **mémoire** : tout ce que Jurgenita retient de vous. |
| 🎙 **Console** | Conversation libre avec une experte : stratégie, algorithmes, bad buzz, tarifs… En mode réel, elle lit vos données, planifie, prépare des brouillons, mémorise vos préférences et **cherche les tendances sur le web**. |

### Commandes vocales

- Touchez l'orbe, cliquez sur 🎙 ou **maintenez Espace** pour parler.
- Cochez **Écoute permanente** puis dites : « *Jurgenita, briefing* », « *Jurgenita, ouvre les mails* », « *Jurgenita, comment répondre au troll ?* »
- 🔊 coupe ou réactive sa voix.

## Architecture

```
jurgenita/
├── server.js          serveur HTTP (sans framework) + API JSON
├── CONNEXIONS.md      guide pour brancher vos comptes
├── src/
│   ├── connectors/    google.js (Gmail, Agenda) · meta.js (Instagram, Facebook) · telegram.js
│   ├── sources.js     vrais comptes si connectés, sinon données de démo
│   ├── claude.js      mode réel : sorties structurées + agent avec outils (API Claude)
│   ├── demo.js        mode démo : réponses calculées à partir des données locales
│   ├── prompts.js     personnalité de Jurgenita
│   ├── schemas.js     formats JSON garantis (briefing, réponse mail, pack, triage)
│   └── store.js       lecture/écriture des données JSON
├── data/              données de démo (mails, communauté, agenda, stats, profil…)
│   ├── runtime/       ce que Jurgenita modifie (calendrier, brouillons, mémoire), ignoré par git
│   └── secrets/       jeton Google, ignoré par git
└── public/            interface : HUD, orbe animé, voix (Web Speech API)
```

- Modèle : `claude-opus-5-5` (modifiable avec `JURGENITA_MODEL`).
- Les modules utilisent les **sorties structurées** : le JSON est garanti conforme au schéma.
- La console utilise le **tool runner** du SDK avec 8 outils locaux plus la recherche web.
- Les **replis côté serveur** sont activés (`fallbacks: "default"`) : si un classifieur de sécurité refuse une requête, l'API la relance sur le modèle de repli recommandé au lieu d'échouer. Retirez `FALLBACK` dans `src/claude.js` si vous n'en voulez pas.
- Le serveur n'écoute que sur `127.0.0.1`, car il n'a pas d'authentification.

## Prochaines étapes

1. **Hébergement en ligne** : Jurgenita tourne 24 h/24 (briefing Telegram même ordinateur éteint), avec un mot de passe.
2. **Lecture des DM** Instagram et Facebook (validation Meta nécessaire).
3. **Voix premium** : synthèse vocale neuronale pour donner à Jurgenita une voix unique.
4. **TikTok et YouTube** : statistiques et commentaires.
5. **Veille concurrentielle** hebdomadaire sur les comptes et hashtags de la niche.
