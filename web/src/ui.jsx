import { createContext, useCallback, useContext, useEffect, useState } from "react";

// ---------------- Routing (hash based, works offline and on Netlify) ----------------

export function parseHash() {
  const h = window.location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  return { path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(qs || "") };
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (path) => { window.location.hash = path; };

// ---------------- Formatting (UK time) ----------------

const TZ = "Europe/London";
export const fmtDateTime = (iso) => iso ? new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(iso)) : "";
export const fmtDate = (iso) => iso ? new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, weekday: "short", day: "numeric", month: "short",
}).format(new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso)) : "";
export const fmtTime = (iso) => iso ? new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(iso)) : "";
export const money = (n) => `£${(Number(n) || 0).toFixed(2)}`;
export const todayLondon = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
export function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
/** London date + time -> ISO instant */
export function londonToIso(date, time) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const asLondon = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (asLondon - guess)).toISOString();
}

export const STEPS = [
  { n: 1, key: "enq", label: "Enq", long: "Enquiry" },
  { n: 2, key: "visit", label: "Visit", long: "Site visit" },
  { n: 3, key: "spec", label: "Spec", long: "Specification" },
  { n: 4, key: "quote", label: "Quote", long: "Quote & questions" },
  { n: 5, key: "book", label: "Book", long: "Schedule job" },
];

export const SOURCE_CHIP = {
  email: ["Email", "blue"], whatsapp: ["WhatsApp", "green"], sms: ["SMS", ""],
  phone: ["Phone", ""], web: ["Website", "blue"], other: ["Other", ""],
};

export const MISSING_LABEL = {
  name: "Needs name", phone: "Needs phone", email: "Needs email", address: "Needs address",
  postcode: "Needs postcode", photos: "Needs photos", access: "Access unknown", waste: "Waste not agreed",
};

// ---------------- Toasts ----------------

const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [t, setT] = useState(null);
  const show = useCallback((msg, kind = "") => {
    setT({ msg, kind, id: Date.now() });
  }, []);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setT(null), t.kind === "error" ? 6000 : 3000);
    return () => clearTimeout(id);
  }, [t]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <div className={`toast ${t.kind}`} role="status">{t.msg}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Run an async action with a busy flag and error toast. */
export function useBusy() {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const run = useCallback(async (key, fn, okMsg) => {
    setBusy(key);
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast(e.message || String(e), "error");
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return [busy, run];
}

// ---------------- Icons ----------------

const P = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
export const Icon = {
  back: () => <svg width="20" height="20" viewBox="0 0 20 20" {...P}><path d="M12 4l-6 6 6 6" /></svg>,
  plus: () => <svg width="16" height="16" viewBox="0 0 16 16" {...P}><path d="M8 2v12M2 8h12" /></svg>,
  jobs: () => <svg width="22" height="22" viewBox="0 0 22 22" {...P}><rect x="3" y="4" width="16" height="14" rx="2" /><path d="M3 9h16" /></svg>,
  cal: () => <svg width="22" height="22" viewBox="0 0 22 22" {...P}><rect x="3" y="5" width="16" height="14" rx="2" /><path d="M3 9h16M7 3v4M15 3v4" /></svg>,
  camera: () => <svg width="22" height="22" viewBox="0 0 22 22" {...P}><path d="M3 7h4l2-3h4l2 3h4v11H3z" /><circle cx="11" cy="12" r="3" /></svg>,
  gallery: () => <svg width="20" height="20" viewBox="0 0 22 22" {...P}><rect x="3" y="4" width="16" height="14" rx="2" /><path d="M3 15l5-5 4 4 3-3 4 4" /></svg>,
  settings: () => <svg width="22" height="22" viewBox="0 0 22 22" {...P}><circle cx="11" cy="11" r="3" /><path d="M11 2v3M11 17v3M2 11h3M17 11h3M4.6 4.6l2.1 2.1M15.3 15.3l2.1 2.1M4.6 17.4l2.1-2.1M15.3 6.7l2.1-2.1" /></svg>,
  sync: () => <svg width="20" height="20" viewBox="0 0 22 22" {...P}><path d="M4 11a7 7 0 0 1 12-5l2 2M18 11a7 7 0 0 1-12 5l-2-2M18 4v4h-4M4 18v-4h4" /></svg>,
  trash: () => <svg width="16" height="16" viewBox="0 0 16 16" {...P}><path d="M3 4h10M6 4V2h4v2M5 4l1 10h4l1-10" /></svg>,
};

// ---------------- Layout pieces ----------------

export function BottomNav({ active }) {
  const items = [
    ["#/jobs", "jobs", "Jobs", Icon.jobs],
    ["#/calendar", "calendar", "Calendar", Icon.cal],
    ["#/camera", "camera", "Camera", Icon.camera],
    ["#/settings", "settings", "Settings", Icon.settings],
  ];
  return (
    <nav className="nav" aria-label="Main">
      <div className="nav-inner">
        {items.map(([href, key, label, I]) => (
          <a key={key} href={href} className={active === key ? "on" : ""} aria-current={active === key ? "page" : undefined}>
            <I />{label}
          </a>
        ))}
      </div>
    </nav>
  );
}

export function BackBar({ title, eyebrow, back = "#/jobs", right }) {
  return (
    <div className="bar">
      <a className="icon-btn" href={back} aria-label="Back"><Icon.back /></a>
      <div className="titles">
        {eyebrow && <span className="step">{eyebrow}</span>}
        <span className="name">{title}</span>
      </div>
      {right}
    </div>
  );
}

export function Sheet({ title, onClose, children }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>{title}</h2>
          <button className="btn small" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const Spinner = () => <span className="spinner" aria-label="Working" />;

/** Text input that saves when you leave the field. */
export function SaveField({ label, value, onSave, type = "text", multiline = false, rows = 3, placeholder }) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  const commit = () => { if ((v ?? "") !== (value ?? "")) onSave(v === "" ? null : v); };
  return (
    <label className="field">
      {label}
      {multiline
        ? <textarea rows={rows} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} />
        : <input type={type} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} />}
    </label>
  );
}
