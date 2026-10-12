import { createClient } from "npm:@supabase/supabase-js@2";

export const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Checks the caller is signed in and listed in app_users. Returns their email. */
export async function requireAppUser(req: Request): Promise<string> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Not signed in");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user?.email) throw new HttpError(401, "Not signed in");
  const email = data.user.email.toLowerCase();
  const { data: row } = await admin.from("app_users").select("email").ilike("email", email).maybeSingle();
  if (!row) throw new HttpError(403, "This account is not allowed to use the app");
  return email;
}

export async function getConfig(key: string): Promise<string | null> {
  const { data } = await admin.from("server_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

export async function setConfig(key: string, value: string) {
  await admin.from("server_config").upsert({ key, value });
}

export async function getSettings() {
  const { data, error } = await admin.from("app_settings").select("*").eq("id", 1).single();
  if (error) throw error;
  return data;
}

export function handleError(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  console.error(e);
  return json({ error: e instanceof Error ? e.message : String(e) }, 500);
}
