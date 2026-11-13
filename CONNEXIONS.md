# Brancher Jurgenita sur vos vrais comptes

Il y a deux sortes de connexions :

- **Les vôtres** (clé Claude, Gmail, Agenda, Telegram) se règlent dans le fichier **`.env`** du dossier `jurgenita` (copiez `.env.example` en `.env`). Après chaque modification du `.env`, **relancez Jurgenita** : `Ctrl + C` puis `npm.cmd start`.
- **Celles de chaque marque** (Instagram, Facebook, Meta Ads, avis Google, TikTok, LinkedIn) se saisissent dans **Profil → Accès de la marque**, après avoir choisi la marque en haut à droite. Elles sont gardées dans `data/secrets/`, hors de Git, dans un dossier réservé à votre compte (voir [la section 9](#9-protection-du-dossier-des-secrets)). Pour la première marque, vous pouvez aussi les mettre dans le `.env`.

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

---

## 9. Protection du dossier des secrets

À chaque démarrage, Jurgenita vérifie que le dossier `data/secrets/` (accès des marques, jeton Google) n'est accessible qu'à vous. Le résultat s'affiche dans le terminal et dans **Profil → Connexions**, sur la ligne « Protection des secrets » :

| Indication | Signification |
| --- | --- |
| **Protégée** | Rien à faire. |
| **Corrigée** | Des droits trop larges ont été resserrés au démarrage. L'état d'origine est sauvegardé. |
| **À vérifier** | Situation incertaine : rien n'a été modifié. Suivez « Que faire ». |
| **Insuffisante** | D'autres comptes de l'ordinateur peuvent lire vos accès ou remplacer le dossier. Suivez « Que faire ». |
| **Accès refusé** | Jurgenita elle-même ne peut pas lire ses accès : les connexions des marques et Google sont indisponibles, et l'enregistrement des accès est refusé. |

**Ce que fait la correction automatique**

- **Windows** : elle coupe l'héritage du dossier `data\secrets` et n'y laisse que votre compte, SYSTEM et Administrateurs (contrôle total). Le contenu hérite de cette protection.
- **Linux et macOS** : elle retire les droits du groupe et des autres comptes (dossiers `700`, fichiers `600`). Un fichier en lecture seule le reste : `444` devient `400`.
- Elle ne fait que **resserrer**. Elle n'ajoute jamais un droit et ne modifie jamais les dossiers parents ni le fichier `.env` : celui-ci est seulement vérifié, et la commande conseillée s'affiche, à lancer vous-même.
- Elle s'arrête sans rien modifier dans ces cas :
  - un autre compte peut supprimer, renommer ou remplacer un dossier parent, ou en changer les droits. Sous Windows : droits DELETE, DELETE_CHILD, WRITE_DAC ou WRITE_OWNER. Sous Linux et macOS : dossier modifiable par d'autres comptes sans bit sticky, groupe partagé avec d'autres comptes, ou ACL ;
  - une règle de refus, un lien ou une jonction se trouve dans le dossier des secrets ;
  - l'analyse est incertaine : membres d'un groupe inconnus, annuaire réseau, autorisations illisibles.
- Un dossier partagé avec bit sticky (comme `/tmp`) n'est pas jugé vulnérable en soi : seuls les comptes qui ont réellement le droit de remplacer le dossier comptent.

**Le cas le plus courant sous Windows** : si le dossier `jurgenita` est placé directement sous `C:\` (par exemple `C:\jurgenita`), il hérite de « Utilisateurs authentifiés : Modification ». Tout autre compte de l'ordinateur pourrait alors remplacer `data`. Jurgenita affiche « Insuffisante » et ne corrige rien. Pour régler le problème, **clonez à nouveau le projet dans votre profil** (`C:\Users\<vous>\…`), puis recopiez-y `.env` et `data\`. Un simple déplacement sur le même disque conserve les anciennes autorisations.

**Vérifier sans rien modifier**

- Windows (PowerShell) : `$env:JURGENITA_SECRETS_PERMISSIONS="verifier"; npm.cmd start`
- Linux, macOS : `JURGENITA_SECRETS_PERMISSIONS=verifier npm start`

Toute valeur autre que `corriger` (par défaut) ou `verifier` est traitée comme `verifier`.

**Voir les droits vous-même**

- Windows : `icacls data\secrets /T`
- Linux : `ls -laR data/secrets`
- macOS : `ls -laeR data/secrets`

**Revenir en arrière**

Avant chaque correction, Jurgenita écrit une sauvegarde des droits d'origine dans `data/secret-permissions-backups/`. Ce dossier est hors de Git et réservé à votre compte. Il ne contient aucun secret, seulement des droits. Pour restaurer :

```
node scripts/restaurer-droits-secrets.mjs data/secret-permissions-backups/<fichier>.json
node scripts/restaurer-droits-secrets.mjs data/secret-permissions-backups/<fichier>.json --appliquer
```

- La première commande affiche un aperçu, sans rien modifier.
- La seconde restaure les droits (le contenu d'abord, le dossier principal en dernier) et les vérifie, droits effectifs compris.
- Le script refuse par prudence (code 4) si un autre compte peut modifier le dossier des sauvegardes ou l'un de ses dossiers parents.
- Il refuse aussi une sauvegarde altérée, sans rien modifier :
  - fichier de sauvegarde dont le propriétaire ou les autorisations ne sont plus ceux attendus (vous, SYSTEM et Administrateurs uniquement) : code 4 ;
  - contenu incohérent (code 3) : chemin hors du dossier des secrets, droits ou type invalides, ou, sous Windows, autorisations à appliquer qui ne correspondent pas à l'état enregistré.
- Sous Windows, le propriétaire, la protection et les autorisations explicites sont rétablis à l'identique. Les autorisations héritées sont recalculées par Windows : même ensemble, ordre parfois différent, mêmes droits effectifs (vérifiés compte par compte).
- Sous Windows, `icacls data\secrets /reset /T /C /Q` rétablit simplement les autorisations héritées du dossier parent.

**Sauvegardes jamais écrasées** : chaque correction crée un nouveau fichier ; une sauvegarde existante n'est jamais remplacée. Si la sauvegarde ne peut pas être écrite, aucune permission du dossier des secrets n'est modifiée.

**Emplacement des sauvegardes** : par défaut, à côté du dossier des secrets. Vous pouvez le changer avec `JURGENITA_SECRETS_BACKUP_DIR`, mais jamais à l'intérieur du dossier des secrets, ni l'inverse : la correction serait alors interrompue.

**Disques particuliers** : sur un disque réseau, FAT ou exFAT (clé USB, par exemple), les droits ne peuvent pas être garantis. Jurgenita le signale sans rien corriger. Sous WSL, un projet placé sur `/mnt/c` ne garde pas les droits Linux : placez-le dans le système de fichiers Linux (`~/…`).

**Ce qui a été vérifié sous Windows** : les tests Windows (vraies autorisations NTFS) ont été exécutés sur les machines Windows de l'intégration continue GitHub, avec un **compte administrateur, en session élevée**. Restent à vérifier : les **comptes standards** (avec le contrôle de compte d'utilisateur), les **comptes de domaine** et les **comptes Entra ID** (anciennement Azure AD). Sur ces comptes, la protection peut se comporter différemment, par exemple pour la prise de possession ou les groupes du jeton. En cas de doute, lancez d'abord Jurgenita en mode vérification.
