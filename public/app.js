// Interface de Jurgenita : vues, voix (reconnaissance + synthèse), orbe animé.
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// Crée un élément DOM sans jamais interpréter de HTML (les données viennent
// de mails et de commentaires externes).
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Remplace le contenu d'un élément en ignorant les valeurs vides, comme el().
function fill(target, ...children) {
  target.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* stockage indisponible : on continue sans */ }
  return null;
}

async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const res = await fetch(path, {
    method,
    headers: { ...(state.brand ? { "x-marque": state.brand } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.erreur || `Erreur ${res.status}`);
  return data;
}

function toast(text) {
  const t = el("div", { class: "toast" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copié dans le presse-papiers"); }
  catch { toast("Copie impossible dans ce navigateur"); }
}

const fmtDate = (iso) => new Date(iso).toLocaleString("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const LABELS = {
  urgent: "Urgent", a_repondre: "À répondre", opportunite: "Opportunité", a_deleguer: "À déléguer", a_ignorer: "À ignorer",
  positif: "Positif", neutre: "Neutre", negatif: "Négatif", spam: "Spam", haute: "Priorité haute", moyenne: "Priorité moyenne", basse: "Priorité basse",
  aucune: "", masquer: "À masquer", signaler: "À signaler", passer_en_prive: "Passer en privé",
};
const tag = (key) => (LABELS[key] ? el("span", { class: `tag ${key}` }, LABELS[key]) : null);

const state = {
  brand: storage("jurgenita.brand"),
  brands: [],
  profile: null,
  briefing: null,
  triage: null,
  convId: storage("jurgenita.conv") || newConvId(),
  voice: storage("jurgenita.voice") !== "off",
};

function newConvId() {
  const id = crypto.randomUUID();
  storage("jurgenita.conv", id);
  return id;
}

// ---------------------------------------------------------------- Statut / orbe

function setStatus(mode, text) {
  document.body.dataset.state = mode;
  if (text) $("#status-line").textContent = text;
}

const orb = (() => {
  const canvas = $("#orb-canvas");
  const ctx = canvas.getContext("2d");
  const N = 96;
  let t = 0;
  let level = 0.15;
  function frame() {
    const mode = document.body.dataset.state || "idle";
    const target = { idle: 0.15, listening: 0.55, thinking: 0.35, speaking: 0.8 }[mode] ?? 0.15;
    level += (target - level) * 0.06;
    t += mode === "thinking" ? 0.06 : 0.025;
    ctx.clearRect(0, 0, 320, 320);
    const color = mode === "listening" ? "255,150,70" : "79,216,255";
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const wave = Math.sin(a * 3 + t * 2) * 0.5 + Math.sin(a * 7 - t * 3) * 0.3 + Math.sin(a * 13 + t * 5) * 0.2;
      const len = 6 + Math.abs(wave) * 34 * level + (mode === "speaking" ? Math.random() * 10 * level : 0);
      const r = 122;
      ctx.strokeStyle = `rgba(${color},${0.25 + Math.abs(wave) * 0.6})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(160 + Math.cos(a) * r, 160 + Math.sin(a) * r);
      ctx.lineTo(160 + Math.cos(a) * (r + len), 160 + Math.sin(a) * (r + len));
      ctx.stroke();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

// ---------------------------------------------------------------- Voix : synthèse

let frVoice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("fr"));
  frVoice = voices.find((v) => /amélie|audrey|marie|denise|julie|female|femme|google/i.test(v.name)) || voices[0] || null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

function speak(text) {
  if (!state.voice || !("speechSynthesis" in window) || !text) {
    if (document.body.dataset.state !== "listening") setStatus("idle");
    return;
  }
  const clean = text
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/[*_#`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = "fr-FR";
  if (frVoice) u.voice = frVoice;
  u.rate = 1.03;
  u.pitch = 1.05;
  u.onstart = () => setStatus("speaking");
  u.onend = u.onerror = () => setStatus("idle", "En veille. Touchez l'orbe ou dites « Jurgenita ».");
  speechSynthesis.speak(u);
}

function chime() {
  try {
    const ac = new AudioContext();
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = f;
      o.type = "sine";
      g.gain.setValueAtTime(0, ac.currentTime + i * 0.18);
      g.gain.linearRampToValueAtTime(0.18, ac.currentTime + i * 0.18 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + i * 0.18 + 0.9);
      o.connect(g).connect(ac.destination);
      o.start(ac.currentTime + i * 0.18);
      o.stop(ac.currentTime + i * 0.18 + 1);
    });
  } catch { /* audio indisponible */ }
}

// ---------------------------------------------------------------- Voix : reconnaissance

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const WAKE = /\b(jurgenita|jurgnita|jugnita|jurgen|georgina|juanita|jurgita|yourgenita)\b[\s,.!:]*/i;
let rec = null;
let wakeMode = false;
let commandArmed = false;

function startListening({ continuous = false } = {}) {
  if (!Recognition) {
    toast("La reconnaissance vocale n'est pas disponible dans ce navigateur (essayez Chrome ou Edge).");
    return;
  }
  stopListening();
  speechSynthesis?.cancel();
  rec = new Recognition();
  rec.lang = "fr-FR";
  rec.interimResults = true;
  rec.continuous = continuous;
  rec.onresult = (e) => {
    const res = e.results[e.results.length - 1];
    const text = res[0].transcript.trim();
    if (!continuous) {
      $("#chat-input").value = text;
      if (res.isFinal) { stopListening(); $("#chat-input").value = ""; handleUtterance(text); }
      return;
    }
    if (!res.isFinal) return;
    if (commandArmed) {
      commandArmed = false;
      handleUtterance(text);
      return;
    }
    const m = text.match(WAKE);
    if (!m) return;
    const command = text.slice(m.index + m[0].length).trim();
    if (command.length > 3) handleUtterance(command);
    else {
      commandArmed = true;
      chime();
      setStatus("listening", "Oui, Boss ?");
    }
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed") { toast("Micro refusé par le navigateur."); wakeMode = false; $("#wake-on").checked = false; }
  };
  rec.onend = () => {
    if (wakeMode) { try { rec.start(); } catch { /* déjà démarré */ } }
    else if (document.body.dataset.state === "listening") setStatus("idle");
  };
  rec.start();
  setStatus("listening", continuous ? "J'écoute… dites « Jurgenita » puis votre demande." : "Je vous écoute…");
}

function stopListening() {
  if (!rec) return;
  const r = rec;
  rec = null;
  r.onend = null;
  try { r.stop(); } catch { /* rien */ }
}

// ---------------------------------------------------------------- Routage des demandes

function handleUtterance(text) {
  const t = text.toLowerCase();
  if (/\b(briefing|bonjour|bon matin|réveil|quoi de neuf|ma journée)\b/.test(t) && t.length < 60) return runBriefing();
  if (/^(ouvre|affiche|montre)/.test(t)) {
    const views = { mail: "mails", studio: "studio", communaut: "communaute", calendrier: "calendrier", stat: "stats", profil: "profil" };
    const hit = Object.keys(views).find((k) => t.includes(k));
    if (hit) { show(views[hit]); speak("C'est affiché."); return; }
  }
  sendChat(text);
}

// ---------------------------------------------------------------- Console

function addMsg(who, text, tools) {
  const node = el("div", { class: `msg ${who}` }, text);
  if (tools?.length) node.append(el("span", { class: "tools" }, `⚙ ${tools.join(" · ")}`));
  $("#chat-log").append(node);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  return node;
}

async function sendChat(message) {
  addMsg("me", message);
  $("#suggestions").classList.add("hidden");
  const pending = addMsg("ai", "");
  pending.classList.add("typing");
  setStatus("thinking", "Je réfléchis…");
  try {
    const r = await api("/api/chat", { conversationId: state.convId, message });
    pending.remove();
    addMsg("ai", r.texte || "(pas de réponse)", r.outils);
    speak(r.texte);
    if (r.outils?.some((o) => /planifier|brouillon|memoriser/.test(o))) refreshLists();
    if (!state.voice) setStatus("idle", "En veille.");
  } catch (err) {
    pending.remove();
    addMsg("ai", `Incident : ${err.message}`);
    setStatus("idle", "Un souci technique. Réessayez.");
  }
}

// ---------------------------------------------------------------- Navigation

function show(view) {
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  storage("jurgenita.view", view);
  ({ mails: renderMails, communaute: renderCommunity, calendrier: renderCalendar, pub: renderAds, veille: renderVeille, stats: renderStats, profil: renderProfile }[view])?.();
}

// ---------------------------------------------------------------- Briefing

async function runBriefing() {
  show("reveil");
  const btn = $("#btn-briefing");
  btn.disabled = true;
  setStatus("thinking", "Je lis vos mails, vos réseaux et votre agenda…");
  $("#briefing").replaceChildren(el("div", { class: "loading" }, "Préparation du briefing…"));
  try {
    const b = await api("/api/briefing", {});
    state.briefing = b;
    renderBriefing(b);
    speak(b.a_dire);
    if (!state.voice) setStatus("idle", "Briefing prêt.");
  } catch (err) {
    $("#briefing").replaceChildren(el("p", { class: "panel" }, `Impossible de préparer le briefing : ${err.message}`));
    setStatus("idle", "Briefing indisponible.");
  } finally {
    btn.disabled = false;
  }
}

function renderBriefing(b) {
  const inbox = new Map((state.inbox || []).map((m) => [m.id, m]));
  const toReply = b.emails.filter((e) => e.repondre).length;
  $("#briefing").replaceChildren(
    el("p", { class: "greeting" }, b.salutation),
    el("div", { class: "panel" },
      el("h3", { class: "sub", style: "margin-top:0" }, "Priorités du jour"),
      el("div", { class: "prio" }, b.priorites.map((p) =>
        el("div", { class: "prio-item" }, el("div", {}, el("b", {}, p.titre), el("small", {}, p.pourquoi), el("div", { class: "act" }, `→ ${p.action}`)))))),
    el("div", { class: "cols" },
      el("div", { class: "panel" },
        el("h3", { class: "sub", style: "margin-top:0" }, `Emails · ${toReply} réponses prêtes`),
        el("ul", { class: "list clickable" }, b.emails.map((e) =>
          el("li", { onclick: () => { show("mails"); selectMail(e.id); } },
            el("div", { class: "row" }, el("span", { class: "from" }, inbox.get(e.id)?.de.split("<")[0] ?? e.id), tag(e.categorie)),
            el("div", { class: "subj" }, e.resume))))),
      el("div", { class: "panel" },
        el("h3", { class: "sub", style: "margin-top:0" }, "Communauté"),
        el("p", { class: "quote" }, b.communaute.humeur),
        b.communaute.alertes.length ? el("ul", { class: "list", style: "margin-top:12px" }, b.communaute.alertes.map((a) => el("li", {}, `⚠ ${a}`))) : null,
        el("button", { class: "btn small", style: "margin-top:12px", onclick: () => show("communaute") }, `Voir les ${b.communaute.reponses.length} réponses proposées`))),
    el("div", { class: "panel" },
      el("h3", { class: "sub", style: "margin-top:0" }, "Idées de contenu"),
      el("div", { class: "cols" }, b.idees_contenu.map((i) =>
        el("div", {},
          el("span", { class: "tag plat" }, `${i.plateforme} · ${i.format}`),
          el("p", { style: "font-weight:600;margin:8px 0 4px" }, i.accroche),
          el("p", { class: "muted" }, i.idee),
          el("button", { class: "btn small", style: "margin-top:8px", onclick: () => { show("studio"); $("#studio-sujet").value = i.accroche.replace(/[«»"]/g, "").trim(); } }, "✦ Développer au Studio"))))),
    el("div", { class: "panel tip" }, el("b", {}, "Conseil du jour · "), b.conseil_du_jour),
  );
}

// ---------------------------------------------------------------- Mails

let currentMail = null;

async function renderMails() {
  state.inbox = await api("/api/data/inbox");
  const cats = new Map((state.briefing?.emails || []).map((e) => [e.id, e]));
  $("#mail-list").replaceChildren(...state.inbox.map((m) =>
    el("li", { "data-id": m.id, class: m.id === currentMail ? "active" : null, onclick: () => selectMail(m.id) },
      el("div", { class: "row" }, el("span", { class: "from" }, m.de.split("<")[0].trim()), el("span", { class: "date" }, fmtDate(m.recu))),
      el("div", { class: "subj" }, m.objet),
      cats.get(m.id) ? el("div", { style: "margin-top:6px" }, tag(cats.get(m.id).categorie)) : null)));
  if (currentMail) selectMail(currentMail);
}

async function selectMail(id) {
  currentMail = id;
  if (!state.inbox) state.inbox = await api("/api/data/inbox");
  $$("#mail-list > li").forEach((li) => li.classList.toggle("active", li.dataset.id === id));
  const m = state.inbox.find((x) => x.id === id);
  if (!m) return;
  const analysis = state.briefing?.emails.find((e) => e.id === id);
  const draft = el("textarea", { rows: 10 }, analysis?.brouillon || "");
  const subject = el("input", { value: `Re: ${m.objet}` });
  const intention = el("input", { placeholder: "Votre intention (ex. accepter mais négocier à 900 €)" });
  const notes = el("p", { class: "muted" }, analysis ? `Jurgenita : ${analysis.recommandation}` : "Lancez le briefing pour l'analyse, ou rédigez directement une réponse.");
  const address = (m.de.match(/<([^>]+)>/) || [])[1] || m.de;

  async function generate(btn) {
    btn.disabled = true;
    btn.textContent = "Rédaction…";
    try {
      const r = await api("/api/email/reply", { id, intention: intention.value });
      subject.value = r.objet;
      draft.value = r.corps;
      notes.textContent = `Jurgenita : ${r.notes}`;
    } catch (err) { toast(err.message); }
    btn.disabled = false;
    btn.textContent = "✎ Rédiger la réponse";
  }

  $("#mail-detail").replaceChildren(
    el("div", { class: "row" }, el("b", {}, m.objet), analysis ? tag(analysis.categorie) : null),
    el("div", { class: "date" }, `${m.de} · ${fmtDate(m.recu)}`),
    el("pre", {}, m.corps),
    notes,
    el("h3", { class: "sub" }, "Réponse"),
    el("div", { class: "form", style: "margin:0" },
      el("div", { class: "row" }, intention, el("button", { class: "btn gold", onclick: (e) => generate(e.currentTarget) }, "✎ Rédiger la réponse")),
      subject, draft),
    el("div", { class: "actions" },
      el("button", { class: "btn", onclick: () => copy(draft.value) }, "Copier"),
      el("button", { class: "btn", onclick: async (e) => {
        // e.currentTarget n'existe plus après un await : on garde le bouton.
        const button = e.currentTarget;
        button.disabled = true;
        try {
          const r = await api("/api/drafts", { canal: "email", destinataire: address, objet: subject.value, texte: draft.value, threadId: m.threadId, messageId: m.messageId });
          toast(r.gmail ? "Brouillon créé dans Gmail" : "Brouillon enregistré");
        } catch (err) { toast(err.message); }
        button.disabled = false;
      } }, state.connexions?.gmail.connecte ? "Créer le brouillon dans Gmail" : "Enregistrer en brouillon"),
      el("a", { class: "btn primary", href: `mailto:${encodeURIComponent(address)}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(draft.value)}`, onclick: (e) => { e.currentTarget.href = `mailto:${encodeURIComponent(address)}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(draft.value)}`; } }, "Ouvrir dans ma messagerie")),
  );
}

// ---------------------------------------------------------------- Studio

function renderStudioChips() {
  const box = $("#studio-plateformes");
  box.querySelectorAll("label").forEach((l) => l.remove());
  (state.profile?.plateformes || []).forEach((p, i) =>
    box.append(el("label", {}, el("input", { type: "checkbox", value: p, checked: i < 2 }), p)));
}

$("#studio-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  const plateformes = $$("#studio-plateformes input:checked").map((i) => i.value);
  btn.disabled = true;
  setStatus("thinking", "Je crée votre pack de contenu…");
  $("#studio-result").replaceChildren(el("div", { class: "loading" }, "Création en cours…"));
  try {
    const r = await api("/api/studio", { sujet: $("#studio-sujet").value, plateformes, objectif: $("#studio-objectif").value });
    renderStudio(r);
    speak(`Pack prêt. ${r.concept}`);
    if (!state.voice) setStatus("idle", "Pack prêt.");
  } catch (err) {
    $("#studio-result").replaceChildren(el("p", { class: "panel" }, err.message));
    setStatus("idle");
  }
  btn.disabled = false;
});

function tomorrow() {
  const d = new Date(Date.now() + 86400000);
  return d.toISOString().slice(0, 10);
}

function renderStudio(r) {
  fill($("#studio-result"),
    el("div", { class: "panel summary" }, el("b", {}, "Concept · "), r.concept),
    el("div", { class: "posts" }, r.posts.map((p) => {
      const full = `${p.accroche}\n\n${p.legende}\n\n${p.hashtags.join(" ")}`;
      return el("article", { class: "panel post" },
        el("h4", {}, `${p.plateforme} · ${p.format}`),
        el("p", { class: "hook" }, p.accroche),
        el("p", { style: "white-space:pre-wrap" }, p.legende),
        el("p", { class: "hashtags" }, p.hashtags.join(" ")),
        el("dl", {},
          el("dt", {}, "Visuel"), el("dd", {}, p.direction_visuelle),
          el("dt", {}, "Quand"), el("dd", {}, p.meilleur_moment),
          el("dt", {}, "CTA"), el("dd", {}, p.appel_a_l_action)),
        el("div", { class: "actions", style: "display:flex;gap:8px;margin-top:12px" },
          el("button", { class: "btn small", onclick: () => copy(full) }, "Copier"),
          el("button", { class: "btn small gold", onclick: async () => { await api("/api/calendar", { date: tomorrow(), plateforme: p.plateforme, format: p.format, sujet: p.accroche }); toast("Planifié pour demain"); } }, "+ Calendrier")));
    })),
    r.script_video.length ? el("div", { class: "panel", style: "margin-top:14px" },
      el("h3", { class: "sub", style: "margin-top:0" }, "Script vidéo"),
      el("div", { class: "table-wrap" }, el("table", { class: "script" },
        el("thead", {}, el("tr", {}, ["Temps", "Plan", "Voix off", "Texte à l'écran"].map((h) => el("th", {}, h)))),
        el("tbody", {}, r.script_video.map((s) => el("tr", {}, el("td", {}, s.temps), el("td", {}, s.plan), el("td", {}, s.voix_off), el("td", {}, s.texte_ecran))))))) : null,
    r.conseils.length ? el("div", { class: "panel tip", style: "margin-top:14px" }, el("h3", { class: "sub", style: "margin-top:0" }, "Conseils de Jurgenita"), el("ul", {}, r.conseils.map((c) => el("li", {}, c)))) : null,
  );
}

// ---------------------------------------------------------------- Analyse photo / vidéo

// Réduit une image (ou une image de vidéo) en JPEG de 1568 px maximum.
function toJpeg(source, width, height) {
  const scale = Math.min(1, 1568 / Math.max(width, height));
  const canvas = el("canvas", { width: Math.round(width * scale), height: Math.round(height * scale) });
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { resolve([toJpeg(img, img.naturalWidth, img.naturalHeight)]); URL.revokeObjectURL(img.src); };
    img.onerror = () => reject(new Error("Image illisible"));
    img.src = URL.createObjectURL(file);
  });
}

// Extrait 4 images réparties sur la durée de la vidéo.
function videoFrames(file, count = 4) {
  return new Promise((resolve, reject) => {
    const video = el("video", { muted: true, playsinline: true, preload: "auto" });
    video.src = URL.createObjectURL(file);
    video.onerror = () => reject(new Error("Vidéo illisible dans ce navigateur"));
    video.onloadedmetadata = async () => {
      const frames = [];
      for (let i = 0; i < count; i++) {
        video.currentTime = (video.duration * (i + 0.5)) / count;
        await new Promise((r) => { video.onseeked = r; });
        frames.push(toJpeg(video, video.videoWidth, video.videoHeight));
      }
      URL.revokeObjectURL(video.src);
      resolve(frames);
    };
  });
}

async function analyseMedia(file) {
  if (!file) return;
  const isVideo = file.type.startsWith("video/");
  if (!isVideo && !file.type.startsWith("image/")) { toast("Déposez une photo ou une vidéo"); return; }
  setStatus("thinking", "J'analyse votre visuel…");
  $("#vision-result").replaceChildren(el("div", { class: "loading" }, isVideo ? "Extraction des images de la vidéo…" : "Analyse en cours…"));
  try {
    const frames = isVideo ? await videoFrames(file) : await loadImage(file);
    $("#vision-preview").replaceChildren(...frames.map((src) => el("img", { src, alt: "" })));
    const images = frames.map((src) => ({ media_type: "image/jpeg", data: src.split(",")[1] }));
    const r = await api("/api/vision", { images, video: isVideo, contexte: $("#vision-contexte").value });
    renderVision(r);
    speak(`${r.verdict} Note d'accroche : ${r.note_accroche} sur 10.`);
    if (!state.voice) setStatus("idle", "Analyse terminée.");
  } catch (err) {
    $("#vision-result").replaceChildren(el("p", { class: "panel" }, err.message));
    setStatus("idle");
  }
}

function renderVision(r) {
  const full = `${r.legende}\n\n${r.hashtags.join(" ")}`;
  $("#vision-result").replaceChildren(el("div", { class: "panel" },
    el("div", { class: "score" }, el("span", { class: "score-num" }, `${r.note_accroche}`), el("span", {}, "/10 accroche")),
    el("p", { style: "font-weight:600" }, r.verdict),
    el("p", { class: "muted" }, r.description),
    el("div", { class: "cols", style: "margin-top:12px" },
      el("div", {}, el("h3", { class: "sub" }, "Points forts"), el("ul", {}, r.points_forts.map((x) => el("li", {}, x)))),
      el("div", {}, el("h3", { class: "sub" }, "À améliorer"), el("ul", {}, r.a_ameliorer.map((x) => el("li", {}, x))))),
    el("dl", { class: "post", style: "display:grid;grid-template-columns:auto 1fr;gap:6px 12px" },
      el("dt", { class: "muted" }, "Recadrage"), el("dd", { style: "margin:0" }, r.recadrage),
      el("dt", { class: "muted" }, "Plateforme"), el("dd", { style: "margin:0" }, r.plateforme_ideale),
      el("dt", { class: "muted" }, "Montage"), el("dd", { style: "margin:0" }, r.idee_de_montage)),
    el("h3", { class: "sub" }, "Légende proposée"),
    el("p", { style: "white-space:pre-wrap" }, r.legende),
    el("p", { class: "hashtags" }, r.hashtags.join(" ")),
    el("button", { class: "btn small", onclick: () => copy(full) }, "Copier légende + hashtags")));
}

function initVision() {
  const drop = $("#vision-drop");
  const input = $("#vision-file");
  input.addEventListener("change", () => analyseMedia(input.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); analyseMedia(e.dataTransfer.files[0]); });
}

// ---------------------------------------------------------------- Communauté

async function renderCommunity() {
  const items = await api("/api/data/community");
  const triage = new Map((state.triage?.elements || []).map((x) => [x.id, x]));
  const fromBriefing = new Map((state.briefing?.communaute.reponses || []).map((x) => [x.id, x]));
  $("#community-list").replaceChildren(...items.map((c) => {
    const t = triage.get(c.id);
    const reply = t?.reponse ?? fromBriefing.get(c.id)?.reponse ?? "";
    const moderation = t?.moderation ?? fromBriefing.get(c.id)?.moderation;
    const area = el("textarea", { rows: 3 }, reply);
    return el("li", {},
      el("div", { class: "row" },
        el("span", { class: "from" }, `${c.auteur} · ${c.plateforme} ${c.type}`),
        el("span", { class: "date" }, fmtDate(c.date))),
      c.post ? el("div", { class: "subj" }, `sur « ${c.post} »`) : null,
      el("p", { class: "quote" }, c.texte),
      t || moderation ? el("div", { class: "meta" }, t && tag(t.sentiment), t && tag(t.priorite), tag(moderation), t ? el("span", { class: "muted", style: "font-size:13px" }, t.raison) : null) : null,
      reply || moderation !== "masquer" ? el("div", { class: "suggest" }, area) : null,
      el("div", { class: "meta" },
        el("button", { class: "btn small", onclick: () => copy(area.value) }, "Copier la réponse"),
        el("button", { class: "btn small", onclick: async () => { await api("/api/drafts", { canal: c.plateforme, destinataire: c.auteur, objet: c.type, texte: area.value }); toast("Réponse mise en attente"); } }, "Mettre en attente"),
        c.ref ? el("button", { class: "btn small gold", onclick: async (e) => {
          const where = c.type === "DM" ? `en message privé à ${c.auteur}` : c.type === "avis" ? `sous l'avis Google de ${c.auteur}` : `sous le commentaire de ${c.auteur} sur ${c.plateforme}`;
          if (!area.value.trim() || !confirm(`Publier cette réponse ${where} ?\n\n${area.value}`)) return;
          const button = e.currentTarget;
          button.disabled = true;
          try { await api("/api/community/publish", { reseau: c.reseau, ref: c.ref, message: area.value }); toast("Réponse publiée"); button.textContent = "✓ Publiée"; }
          catch (err) { toast(err.message); button.disabled = false; }
        } }, c.type === "DM" ? "Répondre en privé" : c.type === "avis" ? "Répondre à l'avis" : `Publier sur ${c.plateforme}`) : null));
  }));
  if (state.triage) {
    $("#community-summary").textContent = state.triage.synthese;
    $("#community-summary").classList.remove("hidden");
    $("#community-ideas").replaceChildren(el("div", { class: "panel tip", style: "margin-top:14px" },
      el("h3", { class: "sub", style: "margin-top:0" }, "Idées soufflées par votre communauté"),
      el("ul", {}, state.triage.idees_issues_de_la_communaute.map((i) => el("li", {}, i)))));
  }
}

$("#btn-triage").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setStatus("thinking", "J'analyse votre communauté…");
  try {
    state.triage = await api("/api/community", {});
    await renderCommunity();
    speak(state.triage.synthese);
    if (!state.voice) setStatus("idle", "Analyse terminée.");
  } catch (err) { toast(err.message); setStatus("idle"); }
  btn.disabled = false;
});

// ---------------------------------------------------------------- Calendrier

const STATUTS = ["idée", "brouillon", "en validation", "modifs demandées", "approuvé", "publié", "à publier manuellement", "échec"];
const statut = (x) => el("span", { class: "statut", "data-statut": x }, x);
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
let calendarItems = [];

async function renderCalendar() {
  const [items, drafts] = await Promise.all([api("/api/data/calendar"), api("/api/data/drafts")]);
  calendarItems = items;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => new Date(start.getTime() + i * 86400000));
  $("#cal-grid").replaceChildren(...days.map((d, i) =>
    el("div", { class: `cal-day${i === 0 ? " today" : ""}` },
      el("header", {}, d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })),
      items.filter((x) => x.date === isoDay(d)).sort((a, b) => (a.heure || "").localeCompare(b.heure || "")).map((x) =>
        el("div", { class: "cal-item", "data-statut": x.statut, role: "button", tabindex: "0", onclick: () => editCalendarItem(x.id), onkeydown: (e) => e.key === "Enter" && editCalendarItem(x.id) },
          el("b", {}, `${x.heure || ""} ${x.plateforme} · ${x.format}`), x.sujet, el("small", {}, x.statut))))));
  const todo = items.filter((x) => ["en validation", "modifs demandées", "à publier manuellement", "échec"].includes(x.statut));
  $("#cal-todo").replaceChildren(...(todo.length ? todo.map((x) =>
    el("li", { class: "clickable", style: "cursor:pointer", onclick: () => editCalendarItem(x.id) },
      el("div", { class: "row" }, el("span", { class: "from" }, `${x.plateforme} · ${x.sujet}`), statut(x.statut)),
      el("div", { class: "subj" }, `${x.date} à ${x.heure || "?"}${x.commentaire_client ? ` · Client : « ${x.commentaire_client} »` : ""}${x.erreur ? ` · ${x.erreur}` : ""}`)))
    : [el("li", { class: "muted" }, "Rien en attente.")]));
  $("#drafts").replaceChildren(...(drafts.length ? drafts.slice().reverse().map((d) =>
    el("li", {},
      el("div", { class: "row" }, el("span", { class: "from" }, `${d.canal} → ${d.destinataire}`), el("span", { class: "date" }, d.cree ? fmtDate(d.cree) : "")),
      el("div", { class: "subj" }, d.objet),
      el("p", { class: "quote", style: "white-space:pre-wrap;margin-top:6px" }, d.texte),
      el("button", { class: "btn small", onclick: () => copy(d.texte) }, "Copier")))
    : [el("li", { class: "muted" }, "Aucun brouillon pour l'instant.")]));
}

function editCalendarItem(id) {
  const x = calendarItems.find((i) => i.id === id);
  if (!x) return;
  const box = $("#cal-editor");
  const f = {
    date: el("input", { type: "date", value: x.date || "" }),
    heure: el("input", { type: "time", value: x.heure || "18:00" }),
    plateforme: el("select", {}, [...new Set([...(state.profile?.plateformes || []), x.plateforme])].map((p) => el("option", { selected: p === x.plateforme }, p))),
    format: el("input", { value: x.format || "" }),
    sujet: el("input", { value: x.sujet || "" }),
    legende: el("textarea", { rows: 5 }, x.legende || ""),
    image_url: el("input", { value: x.image_url || "", placeholder: "https://… (obligatoire pour publier sur Instagram)" }),
  };
  const values = () => Object.fromEntries(Object.entries(f).map(([k, input]) => [k, input.value]));
  const act = (label, cls, fn) => el("button", { class: `btn small ${cls}`, type: "button", onclick: async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      await fn();
      await renderCalendar();
      // L'éditeur reflète le nouveau statut, sauf si le contenu a été supprimé ou l'éditeur fermé.
      if (!box.classList.contains("hidden") && calendarItems.some((i) => i.id === id)) return editCalendarItem(id);
    } catch (err) { toast(err.message); }
    button.disabled = false;
  } }, label);
  const save = (extra = {}) => api("/api/calendar/update", { id, ...values(), ...extra });
  box.classList.remove("hidden");
  fill(box,
    el("div", { class: "row" }, el("h3", { class: "sub", style: "margin:0" }, "Contenu"), statut(x.statut)),
    x.commentaire_client ? el("p", { class: "summary panel", style: "margin:12px 0" }, `Commentaire du client : « ${x.commentaire_client} »`) : null,
    x.erreur ? el("p", { class: "over" }, x.erreur) : null,
    el("div", { class: "form", style: "margin:12px 0" },
      el("div", { class: "form-row" }, el("label", {}, "Date", f.date), el("label", {}, "Heure", f.heure), el("label", {}, "Plateforme", f.plateforme), el("label", {}, "Format", f.format)),
      el("label", {}, "Sujet", f.sujet),
      el("label", {}, "Légende", f.legende),
      el("label", {}, "Image (URL publique)", f.image_url)),
    el("div", { class: "meta" },
      act("Enregistrer", "", async () => { await save(); toast("Contenu enregistré"); }),
      ["idée", "brouillon", "modifs demandées"].includes(x.statut) ? act("Envoyer en validation au client", "gold", async () => { await save({ statut: "en validation" }); toast("En attente du client"); }) : null,
      x.statut !== "approuvé" && x.statut !== "publié" ? act("Approuver moi-même", "", async () => { await save({ statut: "approuvé" }); toast("Approuvé : il partira à l'heure prévue"); }) : null,
      x.statut === "approuvé" ? act("Publier maintenant", "primary", async () => {
        if (!confirm(`Publier maintenant sur ${x.plateforme} ?`)) return;
        await save();
        await api("/api/calendar/publish", { id });
        toast("Publié !");
      }) : null,
      ["approuvé", "à publier manuellement", "échec"].includes(x.statut) ? act("Remettre en brouillon", "", async () => { await save({ statut: "brouillon", erreur: "" }); }) : null,
      act("Supprimer", "danger flat", async () => {
        if (!confirm("Supprimer ce contenu ?")) return;
        await api("/api/calendar/delete", { id });
        box.classList.add("hidden");
      }),
      el("button", { class: "btn small", type: "button", onclick: () => box.classList.add("hidden") }, "Fermer")),
  );
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function refreshLists() {
  const active = $(".view.active")?.id.replace("view-", "");
  if (active === "calendrier") renderCalendar();
  if (active === "profil") renderProfile();
}

$("#cal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/calendar", { date: $("#cal-date").value, plateforme: $("#cal-plateforme").value, format: $("#cal-format").value, sujet: $("#cal-sujet").value });
  $("#cal-sujet").value = "";
  renderCalendar();
});

$("#btn-validation-link").addEventListener("click", async () => {
  try {
    const { chemin } = await api("/api/brand/validation-link", {});
    const url = `${location.origin}${chemin}`;
    await copy(url);
    toast("Lien copié. Il ne fonctionne pour le client qu'une fois Jurgenita hébergée en ligne.");
  } catch (err) { toast(err.message); }
});

// ---------------------------------------------------------------- Stats

async function renderStats() {
  const s = await api("/api/data/stats");
  $("#stats-period").textContent = s.periode;
  const entries = Object.entries(s.plateformes);
  const n = (x) => Number(x ?? 0).toLocaleString("fr-FR");
  $("#btn-report").href = `/rapport.html?marque=${encodeURIComponent(state.brand || "")}`;
  if (!entries.length) {
    $("#stats-tiles").replaceChildren(el("p", { class: "panel muted" }, "Pas encore de statistiques pour cette marque : connectez ses comptes dans Profil."));
    $("#stats-bars").replaceChildren();
    $("#stats-extra").replaceChildren();
    return;
  }
  $("#stats-tiles").replaceChildren(...entries.map(([name, p]) =>
    el("div", { class: "tile" },
      el("div", { class: "label" }, name),
      el("div", { class: "value" }, n(p.abonnes)),
      el("div", { class: `delta${p.taux_engagement < 3 ? " low" : ""}` }, p.source === "réel"
        ? [`● En direct`, p.interactions_moyennes_par_post != null ? ` · ${n(p.interactions_moyennes_par_post)} interactions / post` : ""].join("")
        : `+${n(p.evolution_abonnes)} · ${String(p.taux_engagement ?? "–").replace(".", ",")} % d'engagement`))));
  const max = Math.max(1, ...entries.map(([, p]) => p.abonnes || 0));
  $("#stats-bars").replaceChildren(...entries.map(([name, p]) =>
    el("div", { class: "bar" },
      el("span", {}, name),
      el("div", { class: "bar-track" }, el("div", { class: "bar-fill", style: `width:${(p.abonnes / max) * 100}%` })),
      el("span", { class: "num" }, n(p.abonnes)))));
  // Indicateurs propres à l'activité de la marque (restaurant, e-commerce…).
  const LABELS_EXTRA = { couverts_semaine: "Couverts / semaine", mardi: "Mardi soir", mercredi: "Mercredi soir", samedi: "Samedi", note_google: "Note Google", nb_avis_google: "Avis Google", commandes_semaine: "Commandes / semaine", panier_moyen: "Panier moyen (€)", taux_conversion_site: "Conversion du site (%)" };
  const extra = Object.entries(s.restaurant || s.ventes || {});
  $("#stats-extra").replaceChildren(...extra.map(([k, v]) =>
    el("div", { class: "tile" }, el("div", { class: "label" }, LABELS_EXTRA[k] || k.replace(/_/g, " ")), el("div", { class: "value" }, String(v).replace(".", ",")))));
}

// ---------------------------------------------------------------- Profil

const PROFILE_FIELDS = [
  ["prenom", "Prénom"], ["appellation", "Comment Jurgenita vous appelle"], ["marque", "Marque"],
  ["activite", "Activité"], ["niche", "Niche"], ["ton_de_marque", "Ton de marque"],
  ["plateformes", "Plateformes (une par ligne)"], ["objectifs", "Objectifs (un par ligne)"], ["regles", "Règles à respecter (une par ligne)"],
  ["concurrents", "Concurrents à surveiller (un par ligne)"], ["mots_cles_veille", "Mots-clés de veille (un par ligne)"],
  ["heure_reveil", "Heure de réveil"],
];

async function renderProfile() {
  const [p, notes] = await Promise.all([api("/api/data/profile"), api("/api/data/notes")]);
  state.profile = p;
  const form = $("#profile-form");
  form.replaceChildren(...PROFILE_FIELDS.map(([k, label]) =>
    el("label", {}, label, Array.isArray(p[k])
      ? el("textarea", { name: k, rows: Math.max(3, p[k].length + 1) }, p[k].join("\n"))
      : ["concurrents", "mots_cles_veille", "plateformes", "objectifs", "regles"].includes(k) ? el("textarea", { name: k, rows: 3 }, "")
      : el("input", { name: k, value: p[k] ?? "", type: k === "heure_reveil" ? "time" : "text" }))),
    el("button", { class: "btn primary", type: "submit" }, "Enregistrer"));
  renderConnections();
  renderBrandsAdmin();
  $("#notes").replaceChildren(...(notes.length
    ? notes.map((x) => el("li", {}, x.note, el("div", { class: "date" }, fmtDate(x.date))))
    : [el("li", { class: "muted" }, "Rien pour l'instant. Dites par exemple « Retiens que je ne tourne jamais le lundi ».")]));
}

$("#profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = {};
  for (const [k] of PROFILE_FIELDS) {
    const field = e.currentTarget.elements[k];
    data[k] = field.tagName === "TEXTAREA" ? field.value.split("\n").map((s) => s.trim()).filter(Boolean) : field.value;
  }
  state.profile = await api("/api/profile", data, "PUT");
  renderStudioChips();
  fillPlatformSelect();
  toast("Profil enregistré");
});

$("#btn-reset").addEventListener("click", async () => {
  if (!confirm("Effacer le calendrier, les brouillons et la mémoire ajoutés ?")) return;
  await api("/api/reset", {});
  toast("Données réinitialisées");
  renderProfile();
});

function renderConnections() {
  const c = state.connexions;
  if (!c) return;
  // `label` remplace « Non connecté » quand il faut agir (ex. « À reconnecter »).
  const line = (name, ok, detail, action, label) =>
    el("li", {}, el("div", { class: "row" }, el("b", {}, name), el("span", { class: `tag ${ok ? "positif" : label ? "negatif" : "a_ignorer"}` }, ok ? "Connecté" : label || "Non connecté")),
      el("div", { class: "subj", style: "white-space:normal" }, detail), action ? el("div", { style: "margin-top:8px" }, action) : null);
  fill($("#connexions"),
    line("Cerveau (API Claude)", state.mode === "live", state.mode === "live" ? `Modèle ${state.modele}` : "Mode démo : ajoutez ANTHROPIC_API_KEY dans .env puis relancez."),
    line("Gmail + Google Agenda", c.gmail.connecte,
      c.gmail.connecte ? "Jurgenita lit vos mails des 3 derniers jours et votre agenda, et crée les brouillons dans Gmail."
        : c.gmail.reconnexion ? "Le jeton Google enregistré est illisible (fichier abîmé ou incomplet). En attendant, Jurgenita affiche les mails et l'agenda de démonstration. Reconnectez votre compte Google pour rétablir l'accès."
        : c.gmail.configure ? "Identifiants Google présents : il reste à autoriser l'accès." : "Ajoutez GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env (voir CONNEXIONS.md).",
      c.gmail.connecte
        ? el("button", { class: "btn small danger", style: "margin:0", onclick: async () => { await api("/api/google/disconnect", {}); c.gmail.connecte = false; renderConnections(); toast("Google déconnecté"); } }, "Déconnecter")
        : c.gmail.configure ? el("a", { class: "btn small primary", href: "/auth/google" }, c.gmail.reconnexion ? "Reconnecter mon compte Google" : "Connecter mon compte Google") : null,
      c.gmail.reconnexion ? "À reconnecter" : null),
    line("Avis Google", c.marque.google_business && c.gmail.avis_autorises,
      !c.marque.google_business ? "Renseignez l'établissement Google de la marque ci-dessous." : c.gmail.avis_autorises ? "Avis lus et réponses publiées depuis l'onglet Communauté." : "Reconnectez votre compte Google pour autoriser les avis.",
      c.marque.google_business && c.gmail.configure && !c.gmail.avis_autorises ? el("a", { class: "btn small primary", href: "/auth/google" }, "Reconnecter Google") : null),
    c.marque.acces_illisibles ? line(`⚠ Accès illisibles (${currentBrandName()})`, false,
      "Le fichier des accès de cette marque est abîmé ou inaccessible. Par sécurité, Jurgenita ne l'écrasera pas : restaurez-le, ou retirez-le vous-même avant de ressaisir les accès.") : null,
    line(`Instagram + Facebook (${currentBrandName()})`, c.marque.meta, c.marque.meta ? "Commentaires, messages privés, statistiques et publication programmée." : "Renseignez les accès Meta de la marque ci-dessous (voir CONNEXIONS.md)."),
    line(`Meta Ads (${currentBrandName()})`, c.marque.meta_ads, c.marque.meta_ads ? "Performances des annonces en direct dans l'onglet Publicité." : "Ajoutez l'identifiant du compte publicitaire ci-dessous."),
    line(`TikTok · LinkedIn (${currentBrandName()})`, c.marque.tiktok || c.marque.linkedin, [c.marque.tiktok ? "TikTok connecté" : "TikTok non connecté", c.marque.linkedin ? "LinkedIn connecté" : "LinkedIn non connecté"].join(" · ") + " (statistiques)."),
    line("Telegram", c.telegram.pret,
      c.telegram.pret ? `Briefing envoyé chaque jour à ${state.profile?.heure_reveil || "l'heure de réveil"}. Écrivez au bot pour parler à Jurgenita.` : c.telegram.configure ? "Envoyez un message à votre bot : il vous donnera votre TELEGRAM_CHAT_ID." : "Ajoutez TELEGRAM_BOT_TOKEN dans .env (voir CONNEXIONS.md).",
      c.telegram.pret ? el("button", { class: "btn small", onclick: async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        try { await api("/api/telegram/briefing", {}); toast("Briefing envoyé sur Telegram"); } catch (err) { toast(err.message); }
        button.disabled = false;
      } }, "Envoyer le briefing maintenant") : null),
  );
}

const currentBrandName = () => state.brands.find((b) => b.id === state.brand)?.nom || "";

const CONFIG_FIELDS = [
  ["meta_token", "Meta : jeton d'accès de la page", true],
  ["meta_ig_user_id", "Meta : identifiant du compte Instagram pro"],
  ["meta_page_id", "Meta : identifiant de la page Facebook"],
  ["meta_ad_account_id", "Meta Ads : identifiant du compte publicitaire (act_…)"],
  ["google_business_location", "Avis Google : établissement (accounts/…/locations/…)"],
  ["tiktok_token", "TikTok : jeton d'accès", true],
  ["linkedin_token", "LinkedIn : jeton d'accès", true],
  ["linkedin_org_id", "LinkedIn : identifiant de la page entreprise"],
];

function renderBrandsAdmin() {
  $("#brands-list").replaceChildren(...state.brands.map((b) =>
    el("li", {},
      el("div", { class: "row" },
        el("span", { class: "from" }, el("span", { class: "brand-swatch", style: `display:inline-block;margin-right:8px;background:${b.couleur}` }), b.nom, b.id === state.brand ? " (active)" : ""),
        el("span", { class: "meta" },
          b.id !== state.brand ? el("button", { class: "btn small", onclick: () => setBrand(b.id) }, "Activer") : null,
          state.brands.length > 1 ? el("button", { class: "btn small danger", style: "margin:0", onclick: async () => {
            if (!confirm(`Retirer la marque « ${b.nom} » de Jurgenita ? Ses accès enregistrés seront effacés.`)) return;
            await api("/api/brands/delete", { id: b.id });
            if (b.id === state.brand) state.brand = null;
            await loadStatus();
            renderProfile();
          } }, "Retirer") : null)))));
  const filled = state.connexions?.marque.champs_renseignes || [];
  $("#brand-config").replaceChildren(
    el("h3", { class: "sub", style: "margin-top:0" }, `Accès de la marque ${currentBrandName()}`),
    el("p", { class: "muted" }, "Laissez un champ vide pour garder la valeur déjà enregistrée. Les jetons restent sur votre ordinateur (data/secrets/), jamais dans Git."),
    ...CONFIG_FIELDS.map(([name, label, secret]) =>
      el("label", {}, `${label}${filled.includes(name) ? " · ✓ enregistré" : ""}`,
        el("input", { name, type: secret ? "password" : "text", placeholder: filled.includes(name) ? "•••••• (inchangé)" : "", autocomplete: "off" }))),
    el("button", { class: "btn primary", type: "submit" }, "Enregistrer les accès"));
}

$("#brand-config").addEventListener("submit", async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(CONFIG_FIELDS.map(([name]) => [name, e.currentTarget.elements[name].value]));
  try {
    await api("/api/brand/connexions", values, "PUT");
    await loadStatus();
    renderProfile();
    toast("Accès enregistrés");
  } catch (err) { toast(err.message); }
});

$("#brand-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const b = await api("/api/brands", { nom: $("#brand-name").value });
    $("#brand-name").value = "";
    await setBrand(b.id);
    show("profil");
    toast(`Marque « ${b.nom} » créée : complétez son profil`);
  } catch (err) { toast(err.message); }
});

function fillPlatformSelect() {
  $("#cal-plateforme").replaceChildren(...(state.profile?.plateformes || []).map((p) => el("option", {}, p)));
}

// ---------------------------------------------------------------- Réveil programmé

function initAlarm() {
  const time = $("#alarm-time");
  const on = $("#alarm-on");
  time.value = storage("jurgenita.alarm") || state.profile?.heure_reveil || "07:30";
  on.checked = storage("jurgenita.alarmOn") === "1";
  time.addEventListener("change", () => storage("jurgenita.alarm", time.value));
  on.addEventListener("change", () => {
    storage("jurgenita.alarmOn", on.checked ? "1" : "0");
    toast(on.checked ? `Réveil réglé à ${time.value}. Laissez cet onglet ouvert.` : "Réveil désactivé");
  });
  setInterval(() => {
    const now = new Date();
    const hm = now.toTimeString().slice(0, 5);
    const today = now.toDateString();
    if (on.checked && hm === time.value && storage("jurgenita.alarmFired") !== today) {
      storage("jurgenita.alarmFired", today);
      chime();
      setTimeout(runBriefing, 1800);
    }
  }, 15000);
}

// ---------------------------------------------------------------- Publicité

const euro = (x) => `${Number(x ?? 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

async function renderAds() {
  const data = await api("/api/data/ads");
  $("#ads-period").textContent = `${data.periode}${data.source === "réel" ? " · ● en direct" : " · démo"}`;
  const head = ["Annonce", "Campagne", "Dépense", "Impressions", "Clics", "CTR", "CPC", "Conv.", "ROAS"];
  $("#ads-table").className = "data-table";
  $("#ads-table").replaceChildren(
    el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i > 1 ? "num-cell" : null }, h)))),
    el("tbody", {}, data.annonces.length
      ? data.annonces.map((a) => el("tr", {},
        el("td", {}, a.annonce), el("td", {}, a.campagne),
        el("td", { class: "num-cell" }, euro(a.depense)),
        el("td", { class: "num-cell" }, Number(a.impressions).toLocaleString("fr-FR")),
        el("td", { class: "num-cell" }, Number(a.clics).toLocaleString("fr-FR")),
        el("td", { class: `num-cell${a.ctr < 1 ? " over" : ""}` }, `${String(a.ctr).replace(".", ",")} %`),
        el("td", { class: "num-cell" }, euro(a.cpc)),
        el("td", { class: "num-cell" }, a.conversions),
        el("td", { class: `num-cell${a.roas != null && a.roas < 1 ? " over" : ""}` }, a.roas == null ? "–" : String(a.roas).replace(".", ","))))
      : [el("tr", {}, el("td", { colspan: head.length, class: "muted" }, "Aucune annonce. Connectez Meta Ads dans Profil, ou créez une campagne ci-dessous."))]));
}

$("#btn-ads-review").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setStatus("thinking", "J'analyse vos campagnes…");
  $("#ads-review").replaceChildren(el("div", { class: "loading" }, "Analyse en cours…"));
  try {
    const r = await api("/api/ads/review", {});
    fill($("#ads-review"),
      el("p", { class: "panel summary", style: "margin-top:16px" }, r.synthese),
      el("ul", { class: "list" }, r.decisions.map((d) => el("li", {},
        el("div", { class: "row" }, el("b", {}, d.annonce), el("span", { class: `decision ${d.decision}` }, d.decision)),
        el("div", { class: "subj", style: "white-space:normal" }, d.raison)))),
      r.alertes.length ? el("div", { class: "panel tip", style: "margin-top:12px" }, el("h3", { class: "sub" }, "Alertes"), el("ul", {}, r.alertes.map((a) => el("li", {}, `⚠ ${a}`)))) : null,
      el("div", { class: "panel", style: "margin-top:12px" }, el("h3", { class: "sub" }, "Prochains tests"), el("ul", {}, r.prochains_tests.map((t) => el("li", {}, t)))));
    speak(r.synthese);
    if (!state.voice) setStatus("idle", "Analyse terminée.");
  } catch (err) { $("#ads-review").replaceChildren(); toast(err.message); setStatus("idle"); }
  btn.disabled = false;
});

$("#ads-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  setStatus("thinking", "Je prépare votre campagne…");
  $("#ads-result").replaceChildren(el("div", { class: "loading" }, "Création de la campagne…"));
  try {
    const r = await api("/api/ads/generate", {
      produit: $("#ads-produit").value,
      objectif: $("#ads-objectif").value,
      budget: $("#ads-budget").value,
      audience: $("#ads-audience").value,
      plateformes: $$("#ads-plateformes input:checked").map((i) => i.value),
    });
    renderAdPack(r);
    speak(`Campagne prête. ${r.strategie}`);
    if (!state.voice) setStatus("idle", "Campagne prête.");
  } catch (err) { $("#ads-result").replaceChildren(el("p", { class: "panel" }, err.message)); setStatus("idle"); }
  btn.disabled = false;
});

// Limites de Google Ads : 30 caractères pour un titre, 90 pour une description.
function limited(text, max) {
  return el("span", {}, text, " ", el("small", { class: text.length > max ? "over" : "muted" }, `(${text.length}/${max})`));
}

function renderAdPack(r) {
  $("#ads-result").replaceChildren(
    el("div", { class: "panel summary" }, el("b", {}, "Stratégie · "), r.strategie),
    el("div", { class: "panel", style: "margin-bottom:14px" },
      el("h3", { class: "sub" }, "Audiences"),
      el("ul", { class: "list" }, r.audiences.map((a) => el("li", {}, el("b", {}, a.nom), el("div", { class: "subj", style: "white-space:normal" }, a.ciblage), el("div", { class: "muted", style: "font-size:13px" }, a.pourquoi))))),
    el("div", { class: "posts" }, r.annonces.map((a) => {
      const google = a.plateforme === "Google Ads";
      const full = `${a.titre}\n\n${a.texte_principal}\n\n${a.description}\n\n${a.appel_a_l_action}`;
      return el("article", { class: "panel post ad-card" },
        el("h4", {}, `${a.plateforme} · Variante ${a.variante}`),
        el("div", { class: "meta" }, el("span", { class: "tag plat" }, a.angle)),
        el("p", { class: "hook" }, google ? limited(a.titre, 30) : a.titre),
        el("p", { style: "white-space:pre-wrap" }, a.texte_principal),
        el("p", { class: "muted" }, google ? limited(a.description, 90) : a.description),
        el("dl", {}, el("dt", {}, "CTA"), el("dd", {}, a.appel_a_l_action), el("dt", {}, "Visuel"), el("dd", {}, a.visuel)),
        el("button", { class: "btn small", style: "margin-top:10px", onclick: () => copy(full) }, "Copier l'annonce"));
    })),
    el("div", { class: "cols", style: "margin-top:14px" },
      el("div", { class: "panel" }, el("h3", { class: "sub" }, "Test A/B"), el("p", {}, r.test_ab)),
      el("div", { class: "panel" }, el("h3", { class: "sub" }, "Budget"), el("p", {}, r.repartition_budget)),
      el("div", { class: "panel" }, el("h3", { class: "sub" }, "KPI à suivre"), el("ul", {}, r.kpi_a_suivre.map((k) => el("li", {}, k))))),
  );
}

// ---------------------------------------------------------------- Veille

function renderVeilleData(v) {
  $("#veille-info").textContent = v.mise_a_jour ? `Dernière veille : ${fmtDate(v.mise_a_jour)}` : "Mentions de la marque, actualité des concurrents et tendances de la niche, cherchées sur le web.";
  const link = (m) => (/^https?:\/\//.test(m.url || "") ? el("a", { href: m.url, target: "_blank", rel: "noopener noreferrer", style: "color:var(--cyan)" }, m.titre) : m.titre);
  fill($("#veille-result"),
    v.alerte ? el("div", { class: "panel tip", style: "border-left-color:var(--red);margin-bottom:14px" }, el("b", {}, "⚠ Alerte · "), v.alerte) : null,
    el("div", { class: "panel", style: "margin-bottom:14px" },
      el("h3", { class: "sub" }, "Mentions de la marque"),
      el("ul", { class: "list" }, v.mentions.length ? v.mentions.map((m) => el("li", {},
        el("div", { class: "row" }, el("span", { class: "from" }, m.source), tag(m.sentiment)),
        el("div", { style: "margin-top:4px" }, link(m))))
        : [el("li", { class: "muted" }, "Aucune mention pour l'instant. Lancez la veille.")])),
    el("div", { class: "cols" },
      el("div", { class: "panel" }, el("h3", { class: "sub" }, "Concurrents"),
        el("ul", { class: "list" }, v.concurrents.map((c) => el("li", {}, el("b", {}, c.nom), el("div", { class: "subj", style: "white-space:normal" }, c.activite))))),
      el("div", { class: "panel" }, el("h3", { class: "sub" }, "Tendances"), el("ul", {}, v.tendances.map((t) => el("li", {}, t))),
        v.opportunites?.length ? [el("h3", { class: "sub" }, "Opportunités"), el("ul", {}, v.opportunites.map((o) => el("li", {}, o)))] : null)),
  );
}

async function renderVeille() {
  renderVeilleData(await api("/api/data/veille"));
}

$("#btn-veille").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setStatus("thinking", "Je fais le tour du web…");
  $("#veille-result").replaceChildren(el("div", { class: "loading" }, "Veille en cours (cela peut prendre une minute)…"));
  try {
    const v = await api("/api/veille", {});
    renderVeilleData(v);
    speak(v.alerte || `Veille terminée : ${v.mentions.length} mentions et ${v.tendances.length} tendances.`);
    if (!state.voice) setStatus("idle", "Veille terminée.");
  } catch (err) { toast(err.message); setStatus("idle"); renderVeille(); }
  btn.disabled = false;
});

// ---------------------------------------------------------------- Marques

async function loadStatus() {
  let status;
  try {
    status = await api("/api/status");
  } catch (err) {
    // Marque enregistrée qui n'existe plus : on revient à la marque par défaut.
    if (!state.brand) throw err;
    state.brand = null;
    status = await api("/api/status");
  }
  state.brand = status.marque;
  storage("jurgenita.brand", state.brand);
  state.brands = status.marques;
  state.profile = status.profil;
  state.connexions = status.connexions;
  state.mode = status.mode;
  state.modele = status.modele;
  const badge = $("#mode");
  badge.textContent = status.mode === "live" ? "En ligne" : "Démo";
  badge.title = status.mode === "live" ? status.modele : "Ajoutez une clé API pour le mode réel";
  badge.classList.toggle("demo", status.mode !== "live");
  $("#brand-select").replaceChildren(...state.brands.map((b) => el("option", { value: b.id, selected: b.id === state.brand }, b.nom)));
  $("#brand-swatch").style.background = state.brands.find((b) => b.id === state.brand)?.couleur || "";
  renderStudioChips();
  fillPlatformSelect();
}

async function setBrand(id) {
  state.brand = id;
  state.briefing = null;
  state.triage = null;
  $("#briefing").replaceChildren();
  $("#studio-result").replaceChildren();
  $("#ads-result").replaceChildren();
  $("#ads-review").replaceChildren();
  $("#community-summary").classList.add("hidden");
  $("#community-ideas").replaceChildren();
  $("#cal-editor").classList.add("hidden");
  await loadStatus();
  show($(".view.active")?.id.replace("view-", "") || "reveil");
  toast(`Marque active : ${currentBrandName()}`);
}

// ---------------------------------------------------------------- Démarrage

function tick() {
  $("#clock").textContent = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

async function boot() {
  tick();
  setInterval(tick, 10000);
  setStatus("idle");

  $$(".nav-btn").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
  $("#btn-briefing").addEventListener("click", runBriefing);
  $("#orb").addEventListener("click", () => (rec && !wakeMode ? stopListening() : startListening()));
  $("#orb").addEventListener("keydown", (e) => { if (e.key === "Enter") startListening(); });
  $("#btn-mic").addEventListener("click", () => (rec && !wakeMode ? stopListening() : startListening()));
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#chat-input").value.trim();
    if (!text) return;
    $("#chat-input").value = "";
    handleUtterance(text);
  });
  $$("#suggestions button").forEach((b) => b.addEventListener("click", () => handleUtterance(b.textContent)));
  $("#btn-new-chat").addEventListener("click", async () => {
    await api("/api/chat/reset", { conversationId: state.convId });
    state.convId = newConvId();
    $("#chat-log").replaceChildren();
    $("#suggestions").classList.remove("hidden");
    addMsg("ai", "Nouvelle conversation. Je vous écoute, Boss.");
  });
  const voiceBtn = $("#btn-voice-toggle");
  voiceBtn.setAttribute("aria-pressed", String(state.voice));
  voiceBtn.addEventListener("click", () => {
    state.voice = !state.voice;
    storage("jurgenita.voice", state.voice ? "on" : "off");
    voiceBtn.setAttribute("aria-pressed", String(state.voice));
    if (!state.voice) speechSynthesis?.cancel();
  });
  $("#wake-on").addEventListener("change", (e) => {
    wakeMode = e.target.checked;
    if (wakeMode) startListening({ continuous: true });
    else { stopListening(); setStatus("idle", "En veille."); }
  });

  // Maintenir Espace (hors champ de saisie) pour parler.
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName) && !wakeMode) {
      e.preventDefault();
      startListening();
    }
  });

  $("#brand-select").addEventListener("change", (e) => setBrand(e.target.value));
  try {
    await loadStatus();
  } catch {
    $("#mode").textContent = "Hors ligne";
  }
  $("#cal-date").value = tomorrow();
  initAlarm();
  initVision();
  state.inbox = await api("/api/data/inbox").catch(() => []);

  const name = state.profile?.appellation || "Boss";
  const h = new Date().getHours();
  const hello = h < 12 ? "Bonjour" : h < 18 ? "Bon après-midi" : "Bonsoir";
  addMsg("ai", `${hello} ${name}. Jurgenita en ligne. Lancez le briefing, posez-moi une question ou dites « Jurgenita » en activant l'écoute permanente.`);
  const last = storage("jurgenita.view");
  if (last && last !== "reveil") show(last);
}

boot();
