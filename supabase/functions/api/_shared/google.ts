// Google OAuth, Gmail and Calendar helpers. Tokens live in google_connections (server only).
import { admin, HttpError } from "./supa.ts";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
];

export function redirectUri(): string {
  return `${Deno.env.get("SUPABASE_URL")}/functions/v1/api/google/callback`;
}

function clientCreds() {
  const id = Deno.env.get("GOOGLE_CLIENT_ID");
  const secret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!id || !secret) throw new HttpError(500, "Google client ID and secret have not been added yet");
  return { id, secret };
}

export function authUrl(state: string): string {
  const { id } = clientCreds();
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", id);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent select_account");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(code: string) {
  const { id, secret } = clientCreds();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: id, client_secret: secret,
      redirect_uri: redirectUri(), grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description ?? data.error}`);
  return data as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };
}

export function emailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).email ?? null;
  } catch {
    return null;
  }
}

export async function getConnection() {
  const { data } = await admin.from("google_connections").select("*").eq("id", 1).maybeSingle();
  return data;
}

export async function isConnected(): Promise<boolean> {
  const c = await getConnection();
  return !!c?.refresh_token;
}

/** A valid access token, refreshed when needed. */
export async function accessToken(): Promise<string> {
  const c = await getConnection();
  if (!c?.refresh_token) throw new HttpError(400, "Google is not connected. Connect it in Settings.");
  if (c.access_token && c.access_expires_at && new Date(c.access_expires_at).getTime() > Date.now() + 60_000) {
    return c.access_token;
  }
  const { id, secret } = clientCreds();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id, client_secret: secret,
      refresh_token: c.refresh_token, grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new HttpError(400, `Google connection needs renewing (${data.error}). Reconnect it in Settings.`);
  }
  await admin.from("google_connections").update({
    access_token: data.access_token,
    access_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  }).eq("id", 1);
  return data.access_token;
}

async function gfetch(url: string, init: RequestInit = {}) {
  const token = await accessToken();
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Google API error ${res.status}: ${data?.error?.message ?? text}`);
  return data;
}

export async function revokeToken(token: string) {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
}

// ---------------- Gmail ----------------

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export async function listMessageIds(q: string, max = 25): Promise<{ id: string; threadId: string }[]> {
  const u = new URL(`${GMAIL}/messages`);
  u.searchParams.set("q", q);
  u.searchParams.set("maxResults", String(max));
  const data = await gfetch(u.toString());
  return data?.messages ?? [];
}

function b64urlDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64urlEncode(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove quoted earlier messages from a reply. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message/i.test(line.trim())) break;
    if (/^From: .+/.test(line.trim()) && out.length > 2) break;
    if (line.trim().startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

export interface ParsedEmail {
  id: string;
  threadId: string;
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  messageIdHeader: string;
  references: string;
  date: Date;
  body: string;
  attachments: { filename: string; mimeType: string; attachmentId: string }[];
}

export async function getEmail(id: string): Promise<ParsedEmail> {
  const m = await gfetch(`${GMAIL}/messages/${id}?format=full`);
  const headers: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  const from = headers["from"] ?? "";
  const match = from.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  const fromName = match ? match[1].trim() : "";
  const fromEmail = (match ? match[2] : from).trim().toLowerCase();

  let plain = "", html = "";
  const attachments: ParsedEmail["attachments"] = [];
  const walk = (part: any) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId });
    } else if (part.mimeType === "text/plain" && part.body?.data && !plain) {
      plain = new TextDecoder().decode(b64urlDecode(part.body.data));
    } else if (part.mimeType === "text/html" && part.body?.data && !html) {
      html = new TextDecoder().decode(b64urlDecode(part.body.data));
    }
    for (const p of part.parts ?? []) walk(p);
  };
  walk(m.payload);
  const body = stripQuoted(plain || stripHtml(html) || m.snippet || "");

  return {
    id: m.id,
    threadId: m.threadId,
    fromName,
    fromEmail,
    to: headers["to"] ?? "",
    subject: headers["subject"] ?? "",
    messageIdHeader: headers["message-id"] ?? "",
    references: headers["references"] ?? "",
    date: new Date(Number(m.internalDate)),
    body,
    attachments,
  };
}

export async function getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
  const a = await gfetch(`${GMAIL}/messages/${messageId}/attachments/${attachmentId}`);
  return b64urlDecode(a.data);
}

function encodeHeader(s: string): string {
  // deno-lint-ignore no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${toB64(new TextEncoder().encode(s))}?=`;
}

const b64Lines = (s: string) => toB64(new TextEncoder().encode(s)).replace(/(.{76})/g, "$1\r\n");

export async function sendEmail(opts: {
  to: string; subject: string; body: string; html?: string | null;
  ics?: string | null;
  threadId?: string | null; inReplyTo?: string | null; references?: string | null;
}): Promise<{ id: string; threadId: string }> {
  const headers = [
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`);
    headers.push(`References: ${[opts.references, opts.inReplyTo].filter(Boolean).join(" ")}`);
  }
  const part = (type: string, content: string, extra: string[] = []) =>
    [`Content-Type: ${type}`, "Content-Transfer-Encoding: base64", ...extra].join("\r\n") + "\r\n\r\n" + b64Lines(content);

  let mime: string;
  if (!opts.html && !opts.ics) {
    mime = part("text/plain; charset=UTF-8", opts.body);
  } else {
    const alt = `alt_${crypto.randomUUID().replace(/-/g, "")}`;
    const altParts = [part("text/plain; charset=UTF-8", opts.body)];
    if (opts.html) altParts.push(part("text/html; charset=UTF-8", opts.html));
    const altBody = `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
      altParts.map((p) => `--${alt}\r\n${p}`).join("\r\n") + `\r\n--${alt}--`;
    if (opts.ics) {
      const mix = `mix_${crypto.randomUUID().replace(/-/g, "")}`;
      const icsPart = part('text/calendar; charset=UTF-8; method=PUBLISH; name="invite.ics"', opts.ics,
        ['Content-Disposition: attachment; filename="invite.ics"']);
      mime = `Content-Type: multipart/mixed; boundary="${mix}"\r\n\r\n--${mix}\r\n${altBody}\r\n--${mix}\r\n${icsPart}\r\n--${mix}--`;
    } else {
      mime = altBody;
    }
  }
  const raw = headers.join("\r\n") + "\r\n" + mime;
  const payload: Record<string, string> = { raw: b64urlEncode(new TextEncoder().encode(raw)) };
  if (opts.threadId) payload.threadId = opts.threadId;
  return await gfetch(`${GMAIL}/messages/send`, { method: "POST", body: JSON.stringify(payload) });
}

// ---------------- Calendar ----------------

const CAL = "https://www.googleapis.com/calendar/v3";

export async function listCalendars() {
  const data = await gfetch(`${CAL}/users/me/calendarList?minAccessRole=writer`);
  return (data?.items ?? []).map((c: any) => ({ id: c.id, name: c.summaryOverride ?? c.summary, primary: !!c.primary }));
}

export async function calendarId(): Promise<string> {
  const c = await getConnection();
  return c?.calendar_id || "primary";
}

export async function freeBusy(timeMin: Date, timeMax: Date): Promise<{ start: Date; end: Date }[]> {
  const cal = await calendarId();
  const data = await gfetch(`${CAL}/freeBusy`, {
    method: "POST",
    body: JSON.stringify({
      timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
      timeZone: "Europe/London", items: [{ id: cal }],
    }),
  });
  const busy = data?.calendars?.[cal]?.busy ?? [];
  return busy.map((b: any) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

export async function createEvent(event: Record<string, unknown>): Promise<{ id: string; htmlLink: string }> {
  const cal = await calendarId();
  return await gfetch(`${CAL}/calendars/${encodeURIComponent(cal)}/events`, {
    method: "POST", body: JSON.stringify(event),
  });
}

export async function deleteEvent(eventId: string) {
  const cal = await calendarId();
  try {
    await gfetch(`${CAL}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  } catch (e) {
    console.warn("delete event failed", e);
  }
}
