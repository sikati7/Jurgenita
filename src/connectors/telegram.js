// Connecteur Telegram : envoie le briefing sur le téléphone et permet de
// parler à Jurgenita depuis Telegram (uniquement depuis votre chat).
const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const CHAT = () => process.env.TELEGRAM_CHAT_ID;

export const configured = () => Boolean(TOKEN());
export const ready = () => Boolean(TOKEN() && CHAT());

async function call(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram : ${data.description}`);
  return data.result;
}

export async function send(text, chatId = CHAT()) {
  // Telegram limite un message à 4096 caractères.
  for (let i = 0; i < text.length; i += 4000) {
    await call("sendMessage", { chat_id: chatId, text: text.slice(i, i + 4000) });
  }
}

const ICONS = { urgent: "🔴", a_repondre: "🔵", opportunite: "🟢", a_deleguer: "🟠", a_ignorer: "⚪" };

export function formatBriefing(b) {
  return [
    `☀ ${b.salutation}`,
    "",
    "PRIORITÉS",
    ...b.priorites.map((p, i) => `${i + 1}. ${p.titre}\n   → ${p.action}`),
    "",
    "EMAILS",
    ...b.emails.map((e) => `${ICONS[e.categorie] || "•"} ${e.resume}\n   ${e.recommandation}`),
    "",
    "COMMUNAUTÉ",
    b.communaute.humeur,
    ...b.communaute.alertes.map((a) => `⚠ ${a}`),
    "",
    "IDÉES DE CONTENU",
    ...b.idees_contenu.map((i) => `✦ ${i.plateforme} : ${i.accroche}`),
    "",
    `💡 ${b.conseil_du_jour}`,
    "",
    "Brouillons prêts dans Jurgenita. Répondez-moi ici pour me poser une question.",
  ].join("\n");
}

// Écoute les messages reçus par le bot (long polling) et les confie à onMessage.
export async function listen(onMessage) {
  let offset = 0;
  for (;;) {
    try {
      const updates = await call("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text) continue;
        const chatId = String(msg.chat.id);
        if (!CHAT()) {
          await send(`Bonjour ! Votre identifiant de chat est ${chatId}.\nAjoutez TELEGRAM_CHAT_ID=${chatId} dans le fichier .env puis relancez Jurgenita.`, chatId);
          continue;
        }
        if (chatId !== String(CHAT())) continue; // on ignore les inconnus
        try {
          await call("sendChatAction", { chat_id: chatId, action: "typing" });
          await send(await onMessage(msg.text.trim()));
        } catch (err) {
          await send(`Incident : ${err.message}`);
        }
      }
    } catch (err) {
      console.error("[telegram]", err.message);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}
