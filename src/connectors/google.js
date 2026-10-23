// Connecteur Google : Gmail (lecture + brouillons) et Google Agenda (lecture).
// OAuth « application de bureau » : le jeton est gardé dans data/secrets/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(here, "..", "..", "data", "secrets", "google-token.json");
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.readonly",
];
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

let cached = null; // { access_token, expires_at }

export const configured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const connected = () => configured() && fs.existsSync(TOKEN_FILE);

export function authUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google OAuth : ${data.error_description || data.error}`);
  return data;
}

export async function handleCallback(code, redirectUri) {
  const data = await tokenRequest({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  if (!data.refresh_token) throw new Error("Google n'a pas renvoyé de jeton de rafraîchissement. Réessayez.");
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: data.refresh_token }), { mode: 0o600 });
  cached = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
}

export function disconnect() {
  fs.rmSync(TOKEN_FILE, { force: true });
  cached = null;
}

async function accessToken() {
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const { refresh_token } = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  const data = await tokenRequest({ refresh_token, grant_type: "refresh_token" });
  cached = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return cached.access_token;
}

async function gfetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...options.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google : ${data.error?.message || res.status}`);
  return data;
}

const decode = (b64) => Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function findBody(part) {
  if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
  for (const p of part.parts || []) {
    const text = findBody(p);
    if (text) return text;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decode(part.body.data).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  }
  return "";
}

export async function inbox({ max = 15 } = {}) {
  const q = encodeURIComponent("in:inbox newer_than:3d -category:promotions -category:social");
  const list = await gfetch(`${GMAIL}/messages?maxResults=${max}&q=${q}`);
  const messages = await Promise.all((list.messages || []).map((m) => gfetch(`${GMAIL}/messages/${m.id}?format=full`)));
  return messages.map((m) => {
    const header = (name) => m.payload.headers.find((h) => h.name.toLowerCase() === name)?.value || "";
    return {
      id: m.id,
      threadId: m.threadId,
      messageId: header("message-id"),
      de: header("from"),
      objet: header("subject") || "(sans objet)",
      recu: new Date(Number(m.internalDate)).toISOString(),
      corps: (findBody(m.payload) || m.snippet || "").trim().slice(0, 4000),
    };
  });
}

const b64url = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

// Crée un brouillon dans Gmail (jamais d'envoi).
export async function createDraft({ to, subject, body, threadId, inReplyTo }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  const raw = b64url(`${lines.join("\r\n")}\r\n\r\n${body}`);
  return gfetch(`${GMAIL}/drafts`, { method: "POST", body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }) });
}

export async function agenda() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86400000);
  const params = new URLSearchParams({ timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: "true", orderBy: "startTime" });
  const data = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
  return (data.items || []).map((e) => ({
    heure: e.start.dateTime ? new Date(e.start.dateTime).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }) : "Journée",
    titre: e.summary || "(sans titre)",
    lieu: e.location || "",
  }));
}
