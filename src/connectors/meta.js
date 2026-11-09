// Connecteur Meta (API Graph) pour une marque : commentaires, messages privés,
// statistiques, publication Instagram/Facebook et performances Meta Ads.
// `cfg` vient de brands.config(marque).meta.
const VERSION = () => process.env.META_GRAPH_VERSION || "v23.0";

export const configured = (cfg) => Boolean(cfg.token && (cfg.igUserId || cfg.pageId));
export const adsConfigured = (cfg) => Boolean(cfg.token && cfg.adAccountId);

async function graph(cfg, pathname, params = {}, method = "GET") {
  const url = `https://graph.facebook.com/${VERSION()}/${pathname}`;
  const search = new URLSearchParams({ ...params, access_token: cfg.token });
  const res = method === "GET" ? await fetch(`${url}?${search}`) : await fetch(url, { method, body: search });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Meta : ${data.error?.message || res.status}`);
  return data;
}

const short = (s = "", n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function community(cfg) {
  const items = [];
  if (cfg.igUserId) {
    const media = await graph(cfg, `${cfg.igUserId}/media`, { fields: "id,caption,timestamp", limit: "6" });
    for (const m of media.data || []) {
      const comments = await graph(cfg, `${m.id}/comments`, { fields: "id,text,username,timestamp", limit: "15" });
      for (const c of comments.data || []) {
        items.push({ id: `ig_${c.id}`, ref: c.id, reseau: "instagram", plateforme: "Instagram", type: "commentaire", auteur: `@${c.username}`, post: short(m.caption) || "Publication", texte: c.text, date: c.timestamp });
      }
    }
  }
  if (cfg.pageId) {
    const posts = await graph(cfg, `${cfg.pageId}/posts`, { fields: "id,message,created_time,comments.limit(15){id,message,from,created_time}", limit: "5" });
    for (const p of posts.data || []) {
      for (const c of p.comments?.data || []) {
        items.push({ id: `fb_${c.id}`, ref: c.id, reseau: "facebook", plateforme: "Facebook", type: "commentaire", auteur: c.from?.name || "Anonyme", post: short(p.message) || "Publication", texte: c.message, date: c.created_time });
      }
    }
    items.push(...(await messages(cfg)));
  }
  return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
}

// Messages privés Instagram et Messenger reçus par la page (dernier message
// de chaque conversation, quand il vient du client).
async function messages(cfg) {
  const items = [];
  for (const platform of ["instagram", "messenger"]) {
    let data;
    try {
      data = await graph(cfg, `${cfg.pageId}/conversations`, { platform, fields: "id,messages.limit(1){id,message,from,created_time}", limit: "10" });
    } catch (err) {
      console.error(`[meta] messages ${platform} indisponibles :`, err.message);
      continue;
    }
    for (const conv of data.data || []) {
      const last = conv.messages?.data?.[0];
      if (!last?.message || [cfg.pageId, cfg.igUserId].includes(last.from?.id)) continue;
      items.push({
        id: `dm_${last.id}`, ref: last.from.id, reseau: platform === "instagram" ? "instagram_dm" : "messenger",
        plateforme: platform === "instagram" ? "Instagram" : "Facebook", type: "DM",
        auteur: last.from.username ? `@${last.from.username}` : last.from.name || "Client", post: null, texte: last.message, date: last.created_time,
      });
    }
  }
  return items;
}

// Chiffres réels qui remplacent ceux des données de démo.
export async function stats(cfg) {
  const out = {};
  if (cfg.igUserId) {
    const [profile, media] = await Promise.all([
      graph(cfg, cfg.igUserId, { fields: "followers_count,media_count" }),
      graph(cfg, `${cfg.igUserId}/media`, { fields: "like_count,comments_count,caption", limit: "12" }),
    ]);
    const posts = media.data || [];
    const interactions = posts.map((p) => (p.like_count || 0) + (p.comments_count || 0));
    const best = posts[interactions.indexOf(Math.max(...interactions))];
    out.Instagram = {
      abonnes: profile.followers_count,
      publications: profile.media_count,
      interactions_moyennes_par_post: posts.length ? Math.round(interactions.reduce((a, b) => a + b, 0) / posts.length) : 0,
      meilleur_post: best ? short(best.caption, 50) : "",
    };
  }
  if (cfg.pageId) {
    const page = await graph(cfg, cfg.pageId, { fields: "followers_count,fan_count" });
    out.Facebook = { abonnes: page.followers_count ?? page.fan_count };
  }
  return out;
}

// Répond publiquement à un commentaire, ou en privé à un message.
// Appelé uniquement sur clic explicite.
export async function reply(cfg, { reseau, ref, message }) {
  if (reseau === "instagram") return graph(cfg, `${ref}/replies`, { message }, "POST");
  if (reseau === "facebook") return graph(cfg, `${ref}/comments`, { message }, "POST");
  if (reseau === "instagram_dm" || reseau === "messenger") {
    return graph(cfg, `${cfg.pageId}/messages`, {
      recipient: JSON.stringify({ id: ref }),
      message: JSON.stringify({ text: message }),
      messaging_type: "RESPONSE",
    }, "POST");
  }
  throw new Error("Réseau inconnu");
}

// Publie un contenu du calendrier. Instagram exige une image accessible en ligne.
export async function publish(cfg, { plateforme, legende, image_url }) {
  if (plateforme === "Instagram") {
    if (!cfg.igUserId) throw new Error("Compte Instagram non connecté pour cette marque");
    if (!image_url) throw new Error("Instagram exige une image : ajoutez l'adresse (URL) d'une image en ligne");
    const container = await graph(cfg, `${cfg.igUserId}/media`, { image_url, caption: legende || "" }, "POST");
    const post = await graph(cfg, `${cfg.igUserId}/media_publish`, { creation_id: container.id }, "POST");
    return post.id;
  }
  if (plateforme === "Facebook") {
    if (!cfg.pageId) throw new Error("Page Facebook non connectée pour cette marque");
    const post = image_url
      ? await graph(cfg, `${cfg.pageId}/photos`, { url: image_url, caption: legende || "" }, "POST")
      : await graph(cfg, `${cfg.pageId}/feed`, { message: legende || "" }, "POST");
    return post.post_id || post.id;
  }
  throw new Error(`Publication automatique non disponible pour ${plateforme}`);
}

export const canPublish = (cfg, plateforme) =>
  Boolean(cfg.token) && ((plateforme === "Instagram" && cfg.igUserId) || (plateforme === "Facebook" && cfg.pageId));

const CONVERSIONS = ["purchase", "offsite_conversion.fb_pixel_purchase", "lead", "onsite_conversion.lead_grouped", "complete_registration"];

// Performances des annonces Meta Ads sur 7 jours.
export async function adsInsights(cfg) {
  const data = await graph(cfg, `act_${cfg.adAccountId}/insights`, {
    level: "ad",
    date_preset: "last_7d",
    fields: "ad_name,campaign_name,spend,impressions,clicks,ctr,cpc,actions,purchase_roas",
    limit: "50",
  });
  return {
    periode: "7 derniers jours",
    devise: "EUR",
    source: "réel",
    annonces: (data.data || []).map((a) => ({
      annonce: a.ad_name,
      campagne: a.campaign_name,
      depense: Number(a.spend || 0),
      impressions: Number(a.impressions || 0),
      clics: Number(a.clicks || 0),
      ctr: Number(Number(a.ctr || 0).toFixed(2)),
      cpc: Number(Number(a.cpc || 0).toFixed(2)),
      conversions: (a.actions || []).filter((x) => CONVERSIONS.includes(x.action_type)).reduce((n, x) => n + Number(x.value), 0),
      roas: a.purchase_roas?.[0] ? Number(Number(a.purchase_roas[0].value).toFixed(2)) : null,
    })),
  };
}
