// Small Supabase client: sign-in, database, photo storage and server actions.
export const SUPABASE_URL = "https://ltfbynpckvmqkjbofssr.supabase.co";
export const SUPABASE_KEY = "sb_publishable_qLqf9JRdyma6EBtgrM0oDw_ChcFDREW";
const BUCKET = "job-photos";
const SESSION_KEY = "gt.session";

// ---------------- Session ----------------

let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { session = null; }
const listeners = new Set();

function saveSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* private mode */ }
  listeners.forEach((fn) => fn(session));
}

export function onSession(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function currentSession() {
  return session;
}

async function authFetch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.error_description || data.message || `Sign-in error ${res.status}`);
  return data;
}

function fromTokenResponse(d) {
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(d.expires_in || 3600),
    user: d.user || null,
  };
}

/** Email the user a sign-in link (and a code, if the email template includes one). */
export async function sendSignInEmail(email) {
  const redirect = window.location.origin + window.location.pathname;
  await authFetch(`otp?redirect_to=${encodeURIComponent(redirect)}`, { email, create_user: true });
}

export async function verifyCode(email, token) {
  const d = await authFetch("verify", { type: "email", email, token });
  saveSession(fromTokenResponse(d));
}

/** Pick up tokens from a sign-in link (#access_token=...). Returns an error message if the link failed. */
export function handleSignInRedirect() {
  const h = window.location.hash;
  if (!h.includes("access_token=") && !h.includes("error=")) return null;
  const p = new URLSearchParams(h.replace(/^#\/?/, ""));
  history.replaceState(null, "", window.location.pathname + "#/");
  if (p.get("error")) return p.get("error_description") || p.get("error");
  saveSession({
    access_token: p.get("access_token"),
    refresh_token: p.get("refresh_token"),
    expires_at: Number(p.get("expires_at")) || Math.floor(Date.now() / 1000) + Number(p.get("expires_in") || 3600),
    user: null,
  });
  return null;
}

let refreshing = null;
async function token() {
  if (!session) throw new Error("Not signed in");
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  if (!refreshing) {
    refreshing = authFetch("token?grant_type=refresh_token", { refresh_token: session.refresh_token })
      .then((d) => saveSession(fromTokenResponse(d)))
      .catch((e) => { saveSession(null); throw e; })
      .finally(() => { refreshing = null; });
  }
  await refreshing;
  return session.access_token;
}

export async function getUser() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${await token()}` },
  });
  if (!res.ok) throw new Error("Session expired");
  return res.json();
}

export function signOut() {
  saveSession(null);
}

// ---------------- Database (PostgREST) ----------------

async function rest(method, path, { body, prefer } = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${await token()}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) { saveSession(null); throw new Error("Please sign in again"); }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message || `Database error ${res.status}`);
  return data;
}

const enc = encodeURIComponent;

/** select("jobs", "select=*,customers(*)&step=eq.1&order=created_at.desc") */
export const select = (table, query = "select=*") => rest("GET", `${table}?${query}`);

export async function selectOne(table, query) {
  const rows = await select(table, query);
  return rows?.[0] ?? null;
}

export const insert = (table, rows) =>
  rest("POST", `${table}?select=*`, { body: rows, prefer: "return=representation" });

export async function insertOne(table, row) {
  const rows = await insert(table, row);
  return rows?.[0] ?? null;
}

export const update = (table, id, patch) =>
  rest("PATCH", `${table}?id=eq.${enc(id)}&select=*`, { body: patch, prefer: "return=representation" });

export const remove = (table, id) => rest("DELETE", `${table}?id=eq.${enc(id)}`);

// ---------------- Photos ----------------

export async function uploadPhoto(jobId, file, source) {
  const ext = (file.name?.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${jobId}/${crypto.randomUUID()}.${ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${await token()}`,
      "Content-Type": file.type || "image/jpeg",
      "x-upsert": "false",
    },
    body: file,
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message || `Photo upload failed (${res.status})`);
  }
  return insertOne("photos", { job_id: jobId, storage_path: path, source });
}

export async function photoUrls(paths) {
  if (!paths.length) return {};
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 3600, paths }),
  });
  const data = await res.json().catch(() => []);
  const out = {};
  for (const d of Array.isArray(data) ? data : []) {
    if (d.signedURL) out[d.path] = `${SUPABASE_URL}/storage/v1${d.signedURL}`;
  }
  return out;
}

export async function deletePhoto(photo) {
  await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: [photo.storage_path] }),
  });
  await remove("photos", photo.id);
}

// ---------------- Server actions ----------------

export async function action(name, params = {}) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/api`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: name, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}
