# Brancher Jurgenita sur vos vrais comptes

Tout se règle dans le fichier **`.env`** du dossier `jurgenita` (copiez `.env.example` en `.env`).
Après chaque modification du `.env`, **relancez Jurgenita** : `Ctrl + C` puis `npm.cmd start`.
L'onglet **Profil → Connexions** indique ce qui est branché.

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

## 3. Instagram + Facebook

Jurgenita lit les commentaires de vos 6 dernières publications Instagram et de vos 5 derniers posts Facebook, ainsi que vos abonnés. Depuis l'onglet **Communauté**, le bouton **Publier sur Instagram/Facebook** poste une réponse, toujours après votre confirmation.

**Prérequis** : un compte Instagram **professionnel** (Créateur ou Entreprise) **relié à une page Facebook**. Le réglage se trouve dans Instagram, sous Paramètres → Type de compte.

1. Ouvrez **https://developers.facebook.com → Mes apps → Créer une app** (cas d'usage « Autre », type **Entreprise**).
2. Ouvrez **Outils → Explorateur de l'API Graph** et choisissez votre app.
   - Dans **Autorisations**, ajoutez : `pages_show_list`, `pages_read_engagement`, `pages_manage_engagement`, `instagram_basic`, `instagram_manage_comments`, `business_management`.
   - Cliquez sur **Generate Access Token** et acceptez.
3. Toujours dans l'explorateur, lancez la requête :
   ```
   me/accounts?fields=id,name,access_token,instagram_business_account
   ```
   Dans la réponse, sur la ligne de votre page :
   - `id`, c'est **META_PAGE_ID** ;
   - `instagram_business_account.id`, c'est **META_IG_USER_ID** ;
   - `access_token`, c'est **META_ACCESS_TOKEN** (jeton de page).
4. **Jeton durable** (sinon il expire en une heure) :
   1. Ouvrez **Outils → Débogueur de jeton d'accès**, collez le jeton utilisateur de l'étape 2 et cliquez sur **Prolonger le jeton d'accès**.
   2. Remettez ce jeton prolongé dans l'explorateur et relancez la requête `me/accounts` de l'étape 3.
   3. Le `access_token` de votre page n'expire plus. C'est lui qu'il faut mettre dans `.env`.
5. Dans `.env` :
   ```
   META_ACCESS_TOKEN=EAAG...
   META_IG_USER_ID=1784...
   META_PAGE_ID=1234...
   ```

Meta change souvent ses écrans : si un libellé diffère, cherchez l'équivalent. Les DM ne sont pas encore lus : l'API Messenger/Instagram demande une validation de Meta.

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
