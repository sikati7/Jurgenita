// Connecteur Meta : commentaires et statistiques Instagram (compte pro) et
// d'une page Facebook, via l'API Graph et un jeton d'accès de page.
const VERSION = () => process.env.META_GRAPH_VERSION || "v23.0";
const TOKEN = () => process.env.META_ACCESS_TOKEN;
const IG = () => process.env.META_IG_USER_ID;
const PAGE = () => process.env.META_PAGE_ID;

export const configured = () => Boolean(TOKEN() && (IG() || PAGE()));

async function graph(pathname, params = {}, method = "GET") {
  const url = new URL(`https://graph.facebook.com/${VERSION()}/${pathname}`);
  const search = new URLSearchParams({ ...params, access_token: TOKEN() });
  const res = method === "GET"
    ? await fetch(`${url}?${search}`)
    : await fetch(url, { method, body: search });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Meta : ${data.error?.message || res.status}`);
  return data;
}

const short = (s = "", n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function community() {
  const items = [];
  if (IG()) {
    const media = await graph(`${IG()}/media`, { fields: "id,caption,timestamp", limit: "6" });
    for (const m of media.data || []) {
      const comments = await graph(`${m.id}/comments`, { fields: "id,text,username,timestamp", limit: "15" });
      for (const c of comments.data || []) {
        items.push({ id: `ig_${c.id}`, ref: c.id, reseau: "instagram", plateforme: "Instagram", type: "commentaire", auteur: `@${c.username}`, post: short(m.caption) || "Publication", texte: c.text, date: c.timestamp });
      }
    }
  }
  if (PAGE()) {
    const posts = await graph(`${PAGE()}/posts`, { fields: "id,message,created_time,comments.limit(15){id,message,from,created_time}", limit: "5" });
    for (const p of posts.data || []) {
      for (const c of p.comments?.data || []) {
        items.push({ id: `fb_${c.id}`, ref: c.id, reseau: "facebook", plateforme: "Facebook", type: "commentaire", auteur: c.from?.name || "Anonyme", post: short(p.message) || "Publication", texte: c.message, date: c.created_time });
      }
    }
  }
  return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
}

// Chiffres réels qui remplacent ceux des données de démo.
export async function stats() {
  const out = {};
  if (IG()) {
    const [profile, media] = await Promise.all([
      graph(IG(), { fields: "followers_count,media_count" }),
      graph(`${IG()}/media`, { fields: "like_count,comments_count,caption", limit: "12" }),
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
  if (PAGE()) {
    const page = await graph(PAGE(), { fields: "followers_count,fan_count" });
    out.Facebook = { abonnes: page.followers_count ?? page.fan_count };
  }
  return out;
}

// Publie une réponse sous un commentaire. Appelé uniquement sur clic explicite.
export async function reply({ reseau, ref, message }) {
  if (reseau === "instagram") return graph(`${ref}/replies`, { message }, "POST");
  if (reseau === "facebook") return graph(`${ref}/comments`, { message }, "POST");
  throw new Error("Réseau inconnu");
}
