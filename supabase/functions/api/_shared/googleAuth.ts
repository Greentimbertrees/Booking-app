// Google sign-in state and callback handling.
import { admin, getConfig } from "./supa.ts";
import * as g from "./google.ts";

const enc = new TextEncoder();

async function hmac(data: string): Promise<string> {
  const secret = await getConfig("state_secret");
  if (!secret) throw new Error("state secret missing");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

export async function makeState(returnTo: string): Promise<string> {
  const payload = b64url(JSON.stringify({ r: returnTo, t: Date.now() }));
  return `${payload}.${await hmac(payload)}`;
}

async function readState(state: string): Promise<{ r: string; t: number }> {
  const [payload, sig] = state.split(".");
  if (!payload || !sig || (await hmac(payload)) !== sig) throw new Error("Invalid sign-in state");
  const data = JSON.parse(unb64url(payload));
  if (Date.now() - data.t > 15 * 60_000) throw new Error("Sign-in took too long, please try again");
  return data;
}

function backToApp(returnTo: string, params: Record<string, string>): Response {
  let origin = "";
  try { origin = new URL(returnTo).origin; } catch { /* ignore */ }
  const q = new URLSearchParams(params).toString();
  return new Response(null, { status: 302, headers: { Location: `${origin}/#/settings?${q}` } });
}

export async function callback(url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  let returnTo = "";
  try {
    const st = await readState(state);
    returnTo = st.r;
    const err = url.searchParams.get("error");
    if (err) return backToApp(returnTo, { google: "error", message: err });
    const code = url.searchParams.get("code");
    if (!code) throw new Error("No code from Google");

    const tokens = await g.exchangeCode(code);
    const email = g.emailFromIdToken(tokens.id_token);
    const old = await g.getConnection();
    const sameAccount = old?.google_email && email && old.google_email.toLowerCase() === email.toLowerCase();
    const refresh = tokens.refresh_token ?? (sameAccount ? old?.refresh_token : null);
    if (!refresh) throw new Error("Google did not grant offline access. Remove the app from your Google account permissions and connect again.");

    await admin.from("google_connections").upsert({
      id: 1,
      google_email: email,
      refresh_token: refresh,
      access_token: tokens.access_token,
      access_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      calendar_id: sameAccount ? old?.calendar_id ?? "primary" : "primary",
      calendar_name: sameAccount ? old?.calendar_name ?? email : email,
      last_synced_at: sameAccount ? old?.last_synced_at : null,
    });
    return backToApp(returnTo, { google: "connected" });
  } catch (e) {
    console.error(e);
    return backToApp(returnTo, { google: "error", message: e instanceof Error ? e.message : "Sign-in failed" });
  }
}

