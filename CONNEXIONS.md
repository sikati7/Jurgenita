# Brancher Jurgenita sur vos vrais comptes

Il y a deux sortes de connexions :

- **Les vôtres** (clé Claude, Gmail, Agenda, Telegram) se règlent dans le fichier **`.env`** du dossier `jurgenita` (copiez `.env.example` en `.env`). Après chaque modification du `.env`, **relancez Jurgenita** : `Ctrl + C` puis `npm.cmd start`.
- **Celles de chaque marque** (Instagram, Facebook, Meta Ads, avis Google, TikTok, LinkedIn) se saisissent dans **Profil → Accès de la marque**, après avoir choisi la marque en haut à droite. Elles sont gardées dans `data/secrets/`, hors de Git. Pour la première marque, vous pouvez aussi les mettre dans le `.env`.

L'onglet **Profil → Connexions** indique ce qui est branché pour la marque active.

> Ces clés donnent accès à vos comptes : ne les envoyez à personne et ne les mettez jamais sur GitHub (le `.env` est déjà exclu).

---

## 1. Le cerveau : clé API Anthropic (à faire en premier)

Sans elle, Jurgenita reste en mode démo, même si vos comptes sont connectés.

1. Allez sur **https://console.anthropic.com** et créez un compte (c'est séparé de l'abonnement Claude Pro).
2. **Billing** : ajoutez des crédits (5 $ minimum).
3. **API Keys → Create Key** : copiez la clé (`sk-ant-…`).
4. Dans `.env` : `ANTHROPIC_API_KEY=sk-ant-...`

L'analyse photo et vidéo du Studio ne demande rien de plus.

---

## 2. Gmail + Google Agenda

Jurgenita lit les mails des 3 derniers jours (hors promotions et réseaux sociaux) et votre agenda du jour. Elle crée ses réponses comme **brouillons dans Gmail**, et **n'envoie jamais rien**.

1. Ouvrez **https://console.cloud.google.com** et créez un projet nommé « Jurgenita ».
2. Ouvrez **API et services → Bibliothèque** et activez **Gmail API**, puis **Google Calendar API**.
3. Ouvrez **Écran de consentement OAuth** (ou « Google Auth Platform »).
   - Type : **Externe**. Nom : Jurgenita. Indiquez votre adresse e-mail.
   - Dans **Utilisateurs test**, ajoutez votre adresse Gmail.
4. Ouvrez **Identifiants → Créer des identifiants → ID client OAuth**.
   - Type d'application : **Application de bureau**.
   - Copiez l'**ID client** et le **Code secret** dans `.env` :
     ```
     GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
     GOOGLE_CLIENT_SECRET=xxxx
     ```
5. Relancez Jurgenita, puis dans **Profil → Connexions**, cliquez sur **Connecter mon compte Google**.
   - Google affiche « Cette application n'a pas été validée ». C'est normal, c'est votre propre application. Cliquez sur **Paramètres avancés → Accéder à Jurgenita**, puis autorisez.

**Bon à savoir** : tant que l'application est « En test », Google coupe l'accès au bout de 7 jours. Pour éviter de reconnecter chaque semaine, ouvrez l'écran de consentement et cliquez sur **Publier l'application**. Pour un usage personnel, aucune validation de Google n'est nécessaire.

---

## 3. Instagram, Facebook et Meta Ads (par marque)

Avec ces accès, Jurgenita :
- lit les commentaires des 6 dernières publications Instagram et des 5 derniers posts Facebook, et les **messages privés** Instagram et Messenger ;
- lit les abonnés de la marque ;
- **publie** à l'heure prévue les contenus approuvés du calendrier ;
- lit les **performances des annonces Meta Ads** sur 7 jours ;
- répond à un commentaire ou à un message privé, toujours après votre confirmation.

**Prérequis** : un compte Instagram **professionnel** (Créateur ou Entreprise) **relié à une page Facebook**, sur lequel vous êtes administrateur. Le réglage se trouve dans Instagram, sous Paramètres → Type de compte.

1. Ouvrez **https://developers.facebook.com → Mes apps → Créer une app** (cas d'usage « Autre », type **Entreprise**).
2. Ouvrez **Outils → Explorateur de l'API Graph** et choisissez votre app.
   - Dans **Autorisations**, ajoutez :
     - lecture : `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `business_management` ;
     - commentaires : `pages_manage_engagement`, `instagram_manage_comments` ;
     - messages privés : `pages_messaging`, `instagram_manage_messages` ;
     - publication : `pages_manage_posts`, `instagram_content_publish` ;
     - publicité : `ads_read`.
   - Cliquez sur **Generate Access Token** et acceptez.
3. Toujours dans l'explorateur, lancez la requête :
   ```
   me/accounts?fields=id,name,access_token,instagram_business_account
   ```
   Dans la réponse, sur la ligne de la page de la marque :
   - `id`, c'est l'**identifiant de la page Facebook** ;
   - `instagram_business_account.id`, c'est l'**identifiant du compte Instagram pro** ;
   - `access_token`, c'est le **jeton d'accès de la page**.
4. **Jeton durable** (sinon il expire en une heure) :
   1. Ouvrez **Outils → Débogueur de jeton d'accès**, collez le jeton utilisateur de l'étape 2 et cliquez sur **Prolonger le jeton d'accès**.
   2. Remettez ce jeton prolongé dans l'explorateur et relancez la requête `me/accounts` de l'étape 3.
   3. Le `access_token` de la page n'expire plus. C'est lui qu'il faut enregistrer.
5. **Compte publicitaire** (facultatif) : dans le Gestionnaire de publicités, l'identifiant s'affiche en haut à gauche (`act_123…`).
6. Dans Jurgenita, choisissez la marque en haut à droite, puis **Profil → Accès de la marque** : collez ces valeurs et enregistrez.

**À savoir**
- **Publier sur Instagram exige une image accessible en ligne** : renseignez son adresse (URL) dans le contenu du calendrier. Les vidéos (Reels) ne sont pas encore publiées automatiquement : Jurgenita vous prévient à l'heure prévue pour que vous publiiez à la main.
- **Les contenus de démonstration** (ceux livrés avec Jurgenita) ne sont jamais publiés pour de vrai, même sur un compte connecté. Seuls les contenus que vous créez peuvent partir.
- **Les messages privés** ne peuvent recevoir une réponse que dans les 24 heures qui suivent le message du client (règle de Meta).
- **Gérer les comptes de vos clients** fonctionne si vous êtes administrateur de leur page. Pour une agence avec beaucoup de clients, Meta demande de faire valider l'app (« App Review »).
- **Meta change souvent ses écrans** : si un libellé diffère, cherchez l'équivalent.

---

## 4. Telegram : le briefing sur votre téléphone

Chaque matin, à l'**heure de réveil** du Profil, Jurgenita vous envoie le briefing sur Telegram. Vous pouvez aussi **lui écrire** depuis Telegram (« briefing », ou n'importe quelle question).

1. Dans Telegram, cherchez **@BotFather** et envoyez `/newbot`.
   - Donnez un nom (Jurgenita) puis un identifiant qui finit par `bot` (ex. `jurgenita_jean_bot`).
   - Copiez le **jeton** reçu dans `.env` : `TELEGRAM_BOT_TOKEN=123456:ABC...`
2. Relancez Jurgenita, ouvrez votre bot dans Telegram et envoyez « bonjour ».
   Le bot vous répond avec votre identifiant de chat.
3. Ajoutez-le dans `.env` : `TELEGRAM_CHAT_ID=123456789`, puis relancez.
4. Testez avec **Profil → Connexions → Envoyer le briefing maintenant**.

Jurgenita ne répond qu'à **votre** chat : les inconnus qui trouveraient le bot sont ignorés.

**Important** : l'ordinateur doit être allumé et Jurgenita lancée pour que le briefing parte. Pour le recevoir même ordinateur éteint, il faudra l'héberger sur un petit serveur en ligne : c'est l'étape suivante.

---

## 5. Avis Google (par marque)

Jurgenita lit les avis Google de l'établissement de la marque et publie vos réponses, toujours après confirmation.

1. **Demandez l'accès à l'API Google Business Profile** : Google l'accorde sur demande, via le formulaire « GBP API access request » de la documentation Google Business Profile. Comptez quelques jours.
2. Une fois l'accès accordé, dans votre projet Google Cloud (le même que pour Gmail), activez **My Business Account Management API**, **My Business Business Information API** et **Google My Business API**.
3. Dans Jurgenita, **reconnectez votre compte Google** (Profil → Connexions) pour autoriser la gestion des avis.
4. Trouvez l'identifiant de l'établissement, de la forme `accounts/123/locations/456` : dans l'explorateur d'API de la documentation Google Business Profile, appelez `accounts.list` (pour le numéro de compte), puis `accounts.locations.list` (pour le numéro d'établissement).
5. Collez-le dans **Profil → Accès de la marque → Avis Google**.

---

## 6. TikTok (statistiques, par marque)

Jurgenita lit les abonnés et les vues des 10 dernières vidéos.

1. Créez une app sur **https://developers.tiktok.com** avec **Login Kit** et les autorisations `user.info.basic`, `user.info.stats` et `video.list`.
2. Obtenez un jeton d'accès pour le compte de la marque (connexion TikTok de l'app).
3. Collez-le dans **Profil → Accès de la marque → TikTok**.

**Limite actuelle** : un jeton TikTok expire au bout de 24 heures et Jurgenita ne sait pas encore le renouveler seule. Il faut donc le recoller chaque jour. Le renouvellement automatique fait partie des prochaines étapes.

---

## 7. LinkedIn (abonnés d'une page entreprise, par marque)

1. Créez une app sur **https://www.linkedin.com/developers** et demandez l'accès au produit **Community Management API** (validation par LinkedIn).
2. Générez un jeton d'accès avec l'autorisation `r_organization_social` pour un administrateur de la page.
3. L'identifiant de la page est le nombre dans l'adresse de l'administration de la page (`linkedin.com/company/123456/admin`).
4. Collez le jeton et l'identifiant dans **Profil → Accès de la marque → LinkedIn**. Un jeton LinkedIn dure 60 jours.

---

## 8. La validation par le client

Dans **Calendrier**, le bouton **Lien de validation pour le client** copie un lien secret propre à la marque. Le client y voit les contenus « en validation » et peut les **valider** ou **demander une modification**, avec un commentaire. Vous êtes prévenu sur Telegram.

**Important** : Jurgenita tourne sur votre ordinateur, donc ce lien ne fonctionne pour le client qu'une fois Jurgenita **hébergée en ligne**. En attendant, vous pouvez l'ouvrir vous-même pour montrer l'écran au client.
