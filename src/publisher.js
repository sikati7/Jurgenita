// Publication des contenus du calendrier. Un contenu part seulement s'il est
// « approuvé » (par vous ou par le client) et que son heure est passée.
import * as brands from "./brands.js";
import * as sources from "./sources.js";
import * as meta from "./connectors/meta.js";

// Statuts d'un contenu, dans l'ordre du circuit de validation.
export const STATUTS = ["idée", "brouillon", "en validation", "modifs demandées", "approuvé", "publié", "à publier manuellement", "échec"];

export async function publishNow(brand, id) {
  const item = sources.calendar(brand).find((x) => x.id === id);
  if (!item) throw Object.assign(new Error("Contenu introuvable"), { status: 404 });
  if (item.statut !== "approuvé") throw Object.assign(new Error("Seul un contenu approuvé peut être publié"), { status: 400 });
  if (item.demo) throw Object.assign(new Error("Contenu de démonstration : il n'est jamais publié pour de vrai"), { status: 400 });
  const cfg = brands.config(brand).meta;
  if (!meta.canPublish(cfg, item.plateforme)) {
    throw Object.assign(new Error(`${item.plateforme} n'est pas connecté pour publier automatiquement : publiez-le à la main`), { status: 400 });
  }
  const postId = await meta.publish(cfg, item);
  return sources.updateCalendarItem(brand, id, { statut: "publié", post_id: postId, publie_le: new Date().toISOString(), erreur: "" });
}

const due = (item, now) => item.statut === "approuvé" && item.date && new Date(`${item.date}T${item.heure || "09:00"}`) <= now;

// Appelé chaque minute. `notify` reçoit un texte à envoyer sur Telegram.
export async function tick(notify = async () => {}, now = new Date()) {
  const done = [];
  for (const brand of brands.list()) {
    const cfg = brands.config(brand.id).meta;
    for (const item of sources.calendar(brand.id).filter((x) => due(x, now))) {
      // Les contenus de démonstration ne partent jamais sur un vrai compte.
      if (item.demo || !meta.canPublish(cfg, item.plateforme)) {
        sources.updateCalendarItem(brand.id, item.id, { statut: "à publier manuellement" });
        await notify(`⏰ ${brand.nom} — c'est l'heure de publier sur ${item.plateforme} : « ${item.sujet} »\n\n${item.legende || ""}`);
        done.push({ marque: brand.id, id: item.id, statut: "à publier manuellement" });
        continue;
      }
      try {
        await publishNow(brand.id, item.id);
        await notify(`✅ ${brand.nom} — publié sur ${item.plateforme} : « ${item.sujet} »`);
        done.push({ marque: brand.id, id: item.id, statut: "publié" });
      } catch (err) {
        sources.updateCalendarItem(brand.id, item.id, { statut: "échec", erreur: err.message });
        await notify(`⚠ ${brand.nom} — échec de publication sur ${item.plateforme} : ${err.message}`);
        done.push({ marque: brand.id, id: item.id, statut: "échec" });
      }
    }
  }
  return done;
}
