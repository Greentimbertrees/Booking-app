import { useEffect, useState } from "react";
import * as sb from "./sb.js";
import { BottomNav, fmtDateTime, Icon, money, SaveField, Spinner, useBusy, useToast } from "./ui.jsx";

function GoogleCard({ query }) {
  const [st, setSt] = useState(null);
  const [cals, setCals] = useState(null);
  const [busy, run] = useBusy();
  const toast = useToast();
  const load = () => sb.action("google-status").then(setSt).catch((e) => setSt({ error: e.message }));
  useEffect(() => {
    load();
    const r = query.get("google");
    if (r === "connected") toast("Google connected");
    if (r === "error") toast(`Google connection failed: ${query.get("message") ?? ""}`, "error");
  }, []);
  useEffect(() => {
    if (st?.connected) sb.action("google-calendars").then((r) => setCals(r.calendars)).catch(() => setCals([]));
  }, [st?.connected, st?.google_email]);

  const connect = () => run("connect", async () => {
    const r = await sb.action("google-start", { returnTo: window.location.origin + window.location.pathname });
    window.location.href = r.url;
  });
  const disconnect = () => {
    if (!confirm("Disconnect Google? The app will stop reading Gmail and adding to your calendar until you connect again.")) return;
    run("disc", async () => { await sb.action("google-disconnect"); await load(); }, "Google disconnected");
  };
  const pickCal = (id) => run("cal", async () => {
    const c = cals.find((x) => x.id === id);
    await sb.action("google-set-calendar", { id, name: c?.name });
    await load();
  }, "Calendar changed");
  const syncNow = () => run("sync", async () => {
    const r = await sb.action("sync");
    await load();
    toast(`Checked Gmail: ${r.created ?? 0} new enquiries, ${r.updated ?? 0} replies, ${r.sent ?? 0} reminders sent`);
  });

  if (!st) return <div className="card"><h2>Gmail and Google Calendar</h2><Spinner /></div>;
  return (
    <div className="card">
      <h2>Gmail and Google Calendar</h2>
      {st.error && <div className="banner amber">{st.error}</div>}
      {!st.configured && (
        <div className="banner amber">
          <strong>Google keys not added yet</strong>
          <span>The Google client ID and secret need adding before you can connect. Redirect address to register with Google:</span>
          <code style={{ wordBreak: "break-all", fontSize: 12 }}>{st.redirect_uri}</code>
        </div>
      )}
      {st.configured && !st.aiConfigured && <div className="banner amber">The AI key isn't added yet, so replies can't be drafted.</div>}
      {st.connected ? (
        <>
          <div className="kv">
            <span>Account</span><span><strong>{st.google_email}</strong></span>
            <span>Calendar</span>
            <span>
              {cals === null ? <Spinner /> : (
                <select className="input" value={st.calendar_id ?? "primary"} onChange={(e) => pickCal(e.target.value)} aria-label="Calendar for visits and jobs">
                  {!cals.some((c) => c.id === st.calendar_id) && <option value={st.calendar_id}>{st.calendar_name}</option>}
                  {cals.map((c) => <option key={c.id} value={c.id}>{c.name}{c.primary ? " (main)" : ""}</option>)}
                </select>
              )}
            </span>
            <span>Last check</span><span>{st.last_synced_at ? fmtDateTime(st.last_synced_at) : "Not yet"} · every 5 min</span>
          </div>
          <div className="btn-row">
            <button className="btn" disabled={!!busy} onClick={syncNow}>{busy === "sync" ? <Spinner /> : <><Icon.sync /> Check now</>}</button>
            <button className="btn" disabled={!!busy || !st.configured} onClick={connect}>Switch account</button>
          </div>
          <button className="btn small danger" disabled={!!busy} onClick={disconnect}>Disconnect Google</button>
        </>
      ) : (
        <>
          <span className="small muted">Connect the Google account whose Gmail receives enquiries. Visits and jobs go into its calendar, and you can pick a different calendar after connecting.</span>
          <button className="btn primary" disabled={!st.configured || !!busy} onClick={connect}>{busy === "connect" ? <Spinner /> : "Connect Google"}</button>
        </>
      )}
      <span className="small muted">WhatsApp and SMS: paste messages in with "New enquiry". Replies open in your phone's app, ready to send.</span>
    </div>
  );
}

function RateCards() {
  const [cards, setCards] = useState([]);
  const load = () => sb.select("rate_cards", "select=*&active=eq.true&order=name").then(setCards);
  useEffect(() => { load(); }, []);
  const save = (id, patch) => sb.update("rate_cards", id, patch).then(load);
  const add = () => sb.insertOne("rate_cards", { name: "New rate card" }).then(load);
  return (
    <div className="card">
      <div className="row"><h2>Rate cards</h2><button className="btn small" onClick={add}>+ Add</button></div>
      <span className="small muted">Day rate for the crew, by area or size of job. The quote uses the card you pick.</span>
      {cards.map((c) => (
        <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--line-soft)", paddingTop: 10 }}>
          <div className="grid2">
            <SaveField label="Name" value={c.name} onSave={(v) => save(c.id, { name: v || "Rate card" })} />
            <SaveField label="Day rate £" type="number" value={c.day_rate} onSave={(v) => save(c.id, { day_rate: v === null ? null : Number(v) })} />
          </div>
          <SaveField label="Notes" value={c.notes} onSave={(v) => save(c.id, { notes: v })} />
          <button className="btn small danger" onClick={() => confirm(`Remove ${c.name}?`) && save(c.id, { active: false })}>Remove</button>
        </div>
      ))}
    </div>
  );
}

function Catalogue() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("equipment");
  const load = () => sb.select("catalogue_items", "select=*&active=eq.true&order=kind,name").then(setItems);
  useEffect(() => { load(); }, []);
  const save = (id, patch) => sb.update("catalogue_items", id, patch).then(load);
  const add = async () => {
    if (!name.trim()) return;
    await sb.insertOne("catalogue_items", { name: name.trim(), kind, owned: false, unit: kind === "equipment" ? "day" : "job" });
    setName("");
    load();
  };
  return (
    <div className="card">
      <h2>Equipment and materials</h2>
      <span className="small muted">Standard prices. Hired equipment is charged per day; your own kit is free on the quote unless you set a price.</span>
      {items.map((i) => (
        <div key={i.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 90px 70px 36px", gap: 6, alignItems: "end" }}>
          <SaveField label={i.kind === "equipment" ? "Equipment" : "Material"} value={i.name} onSave={(v) => save(i.id, { name: v || i.name })} />
          <SaveField label={`£ per ${i.unit}`} type="number" value={i.default_cost} onSave={(v) => save(i.id, { default_cost: v === null ? null : Number(v) })} />
          <label className="field">Own
            <input type="checkbox" style={{ minHeight: 22, width: 22, height: 22, accentColor: "var(--green)" }} checked={i.owned} onChange={(e) => save(i.id, { owned: e.target.checked })} />
          </label>
          <button className="icon-btn" aria-label={`Remove ${i.name}`} onClick={() => confirm(`Remove ${i.name}?`) && save(i.id, { active: false })}><Icon.trash /></button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <select className="input" style={{ width: 130 }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
          <option value="equipment">Equipment</option>
          <option value="material">Material</option>
        </select>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <button className="btn" onClick={add}>Add</button>
      </div>
    </div>
  );
}

export function SettingsPage({ query }) {
  const [s, setS] = useState(null);
  const [me, setMe] = useState(null);
  const toast = useToast();
  const load = () => sb.selectOne("app_settings", "select=*&id=eq.1").then(setS).catch((e) => toast(e.message, "error"));
  useEffect(() => { load(); sb.getUser().then(setMe).catch(() => {}); }, []);
  const save = (patch) => sb.update("app_settings", 1, patch).then(load).catch((e) => toast(e.message, "error"));
  const num = (k) => (v) => save({ [k]: v === null ? 0 : Number(v) });

  return (
    <>
      <div className="top"><div><span className="eyebrow">Green Timber Trees</span><h1>Connections &amp; rules</h1></div></div>
      <div className="page">
        <GoogleCard query={query} />
        {!s ? <Spinner /> : (
          <>
            <div className="card">
              <h2>Automatic replies</h2>
              <label className="check"><input type="radio" name="mode" checked={!s.auto_send_first_reply} onChange={() => save({ auto_send_first_reply: false })} />Draft first replies, I approve</label>
              <label className="check"><input type="radio" name="mode" checked={s.auto_send_first_reply} onChange={() => save({ auto_send_first_reply: true })} />Send first replies automatically</label>
              <label className="check"><input type="checkbox" checked={s.auto_send_followups} onChange={(e) => save({ auto_send_followups: e.target.checked })} />Send follow-ups automatically (chasing details, confirming visits)</label>
              <span className="small muted">Automatic sending applies to email. WhatsApp and SMS replies always open on your phone for you to send.</span>
            </div>
            <div className="card">
              <h2>Visit booking</h2>
              <div className="grid2">
                <SaveField label="Call reminder (days before)" type="number" value={s.call_reminder_days} onSave={num("call_reminder_days")} />
                <SaveField label="Customer email (days before)" type="number" value={s.customer_reminder_days} onSave={num("customer_reminder_days")} />
                <SaveField label="Visit length (min)" type="number" value={s.visit_minutes} onSave={num("visit_minutes")} />
                <SaveField label="Visits from" type="time" value={s.visit_day_start?.slice(0, 5)} onSave={(v) => save({ visit_day_start: v || "09:00" })} />
                <SaveField label="Visits until" type="time" value={s.visit_day_end?.slice(0, 5)} onSave={(v) => save({ visit_day_end: v || "16:00" })} />
              </div>
            </div>
            <RateCards />
            <Catalogue />
            <div className="card">
              <h2>Quotes, invoices and emails</h2>
              <SaveField label="Business name" value={s.business_name} onSave={(v) => save({ business_name: v || "Green Timber Trees" })} />
              <SaveField label="Sign-off on emails" value={s.signature} onSave={(v) => save({ signature: v || "Green Timber Trees" })} />
              <div className="grid2">
                <SaveField label="VAT %" type="number" value={s.vat_rate} onSave={num("vat_rate")} />
                <SaveField label="Quote valid (days)" type="number" value={s.quote_valid_days} onSave={num("quote_valid_days")} />
                <SaveField label="Invoice due (days)" type="number" value={s.invoice_due_days} onSave={num("invoice_due_days")} />
              </div>
              <SaveField label="Payment details on invoices" multiline value={s.invoice_footer} onSave={(v) => save({ invoice_footer: v || "" })} />
            </div>
          </>
        )}
        <div className="card">
          <h2>Signed in</h2>
          <span>{me?.email ?? "…"}</span>
          <button className="btn" onClick={sb.signOut}>Sign out</button>
        </div>
      </div>
      <BottomNav active="settings" />
    </>
  );
}
