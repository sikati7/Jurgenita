// Connecteur TikTok (Display API) : abonnés et performances des dernières vidéos.
// Nécessite un jeton utilisateur obtenu via une app TikTok for Developers.
async function call(token, url, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || (data.error?.code && data.error.code !== "ok")) throw new Error(`TikTok : ${data.error?.message || res.status}`);
  return data.data;
}

export async function stats(token) {
  const [info, list] = await Promise.all([
    call(token, "https://open.tiktokapis.com/v2/user/info/?fields=follower_count,likes_count,video_count"),
    call(token, "https://open.tiktokapis.com/v2/video/list/?fields=id,title,view_count,like_count,comment_count,share_count", { max_count: 10 }),
  ]);
  const videos = list.videos || [];
  const best = videos.reduce((a, b) => ((b.view_count || 0) > (a?.view_count || 0) ? b : a), null);
  return {
    abonnes: info.user.follower_count,
    likes_total: info.user.likes_count,
    videos: info.user.video_count,
    vues_moyennes: videos.length ? Math.round(videos.reduce((n, v) => n + (v.view_count || 0), 0) / videos.length) : 0,
    meilleur_post: best ? `${best.title || "Vidéo"} (${best.view_count} vues)` : "",
  };
}
