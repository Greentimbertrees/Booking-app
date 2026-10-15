import { useCallback, useEffect, useMemo, useState } from "react";
import * as sb from "./sb.js";
import {
  addDays, BackBar, fmtDate, fmtDateTime, fmtTime, go, Icon, londonToIso, MISSING_LABEL, money, SaveField,
  Sheet, SOURCE_CHIP, Spinner, STEPS, todayLondon, useBusy, useToast,
} from "./ui.jsx";
import { RemoveJobsSheet } from "./remove.jsx";

// Which council's protected-tree map to check, by postcode area.
function councilFor(postcode) {
  const pc = (postcode || "").toUpperCase().replace(/\s+/g, "");
  const area = (pc.match(/^([A-Z]{1,2}\d{1,2})/) || [])[1] || "";
  if (/^BN(1|2|3|41|42)$/.test(area)) return ["Brighton & Hove TPO map", "https://www.brighton-hove.gov.uk/planning/trees-and-landscaping/tree-preservation-orders"];
  if (/^(BN6|RH1[5-7]|RH19)$/.test(area)) return ["Mid Sussex TPO map", "https://www.midsussex.gov.uk/planning-building/trees-and-hedgerows/tree-preservation-order-tpo-map/"];
  if (/^BN(7|8|9|10)$/.test(area)) return ["Lewes District trees", "https://www.lewes-eastbourne.gov.uk/planning-applications-and-building-control/trees-and-hedges"];
  if (/^BN(11|12|13|14|15|43)$/.test(area)) return ["Adur & Worthing trees", "https://www.adur-worthing.gov.uk/planning-applications/trees/"];
  return ["Planning Portal: works to trees", "https://www.planningportal.co.uk/info/200126/applications/60/consent_types/14"];
}

// ---------------- Data loading ----------------

function useJobData(id) {
  const [d, setD] = useState(null);
  const toast = useToast();
  const load = useCallback(async () => {
    const q = (t, extra = "") => sb.select(t, `select=*&job_id=eq.${id}${extra}`);
    const [job, messages, visits, flora, photos, items, quotes, questions, invoices, rateCards, catalogue, settings] = await Promise.all([
      sb.selectOne("jobs", `select=*,customers(*)&id=eq.${id}`),
      q("messages", "&order=created_at"),
      q("site_visits", "&order=starts_at.desc"),
      q("flora", "&order=sort,created_at"),
      q("photos", "&order=created_at"),
      q("job_items", "&order=sort,created_at"),
      q("quotes", "&order=version.desc"),
      q("job_questions", "&order=created_at"),
      q("invoices", "&order=created_at.desc"),
      sb.select("rate_cards", "select=*&active=eq.true&order=name"),
      sb.select("catalogue_items", "select=*&active=eq.true&order=kind,name"),
      sb.selectOne("app_settings", "select=*&id=eq.1"),
    ]);
    setD({ job, messages, visits, flora, photos, items, quotes, questions, invoices, rateCards, catalogue, settings });
  }, [id]);
  useEffect(() => { load().catch((e) => toast(e.message, "error")); }, [load]);
  return [d, load];
}

// ---------------- Page ----------------

export function JobPage({ id, query }) {
  const [d, reload] = useJobData(id);
  if (!d) return <><BackBar title="Loading…" /><div className="empty"><Spinner /></div></>;
  if (!d.job) return <><BackBar title="Job not found" /><div className="empty">This job has been removed.</div></>;

  const { job } = d;
  const tabKey = query.get("tab") || STEPS[job.step - 1].key;
  const step = STEPS.find((s) => s.key === tabKey) ?? STEPS[0];
  const c = job.customers ?? {};
  const props = { d, reload, job, customer: c };
  const openTab = (key) => go(`/job/${id}?tab=${key}`);

  return (
    <>
      <BackBar
        eyebrow={`Step ${step.n} · ${step.long}`}
        title={c.name || c.email || c.phone || "New enquiry"}
        back={`#/jobs?step=${job.step}`}
        right={<span className={`chip ${SOURCE_CHIP[job.source]?.[1] ?? ""}`}>{SOURCE_CHIP[job.source]?.[0] ?? job.source}</span>}
      />
      <nav className="tabs inbar" aria-label="Job sections">
        {STEPS.map((s) => (
          <a key={s.key} href={`#/job/${id}?tab=${s.key}`} className={`tab ${s.key === step.key ? "on" : ""}`}
            aria-current={s.key === step.key ? "page" : undefined}>{s.label}</a>
        ))}
      </nav>
      <div className="page">
        {job.status !== "open" && job.status !== "won" && (
          <div className="banner amber">This job is {job.status}{job.lost_reason ? `: ${job.lost_reason}` : ""}.</div>
        )}
        {step.key === "enq" && <EnquiryPanel {...props} openTab={openTab} />}
        {step.key === "visit" && <VisitPanel {...props} openTab={openTab} />}
        {step.key === "spec" && <SpecPanel {...props} openTab={openTab} />}
        {step.key === "quote" && <QuotePanel {...props} openTab={openTab} />}
        {step.key === "book" && <BookPanel {...props} />}
        <RemoveJobButton d={d} />
      </div>
    </>
  );
}

function RemoveJobButton({ d }) {
  const [open, setOpen] = useState(false);
  if (d.invoices.length) return null;
  const job = { ...d.job, site_visits: d.visits, invoices: d.invoices };
  return (
    <>
      <button className="btn small danger remove-job" onClick={() => setOpen(true)}><Icon.trash />Remove from app</button>
      {open && (
        <RemoveJobsSheet jobs={[job]} onClose={() => setOpen(false)}
          onRemoved={(r) => { setOpen(false); if (r.removed) go(`/jobs?step=${d.job.step}`); }} />
      )}
    </>
  );
}

// ---------------- Shared bits ----------------

function useSavers(job, customer, reload) {
  const toast = useToast();
  const saveJob = async (patch) => {
    try { await sb.update("jobs", job.id, patch); await reload(); } catch (e) { toast(e.message, "error"); }
  };
  const saveCustomer = async (patch) => {
    try { await sb.update("customers", customer.id, patch); await reload(); } catch (e) { toast(e.message, "error"); }
  };
  return { saveJob, saveCustomer };
}

function BookVisitForm({ job, reload, onDone }) {
  const [slots, setSlots] = useState(null);
  const [date, setDate] = useState(addDays(todayLondon(), 1));
  const [time, setTime] = useState("10:00");
  const [busy, run] = useBusy();
  useEffect(() => {
    sb.action("slots", { postcode: job.postcode, count: 3 }).then((r) => setSlots(r.slots)).catch(() => setSlots([]));
  }, [job.postcode]);
  const book = (startsAt) => run("book", async () => {
    await sb.action("book-visit", { jobId: job.id, startsAt });
    await reload();
    onDone?.();
  }, "Visit booked, calendar and reminders set");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span className="small muted">Free times in your calendar</span>
      <div className="chips">
        {slots === null && <Spinner />}
        {slots?.length === 0 && <span className="small muted">None found (connect Google in Settings), or pick a time below.</span>}
        {slots?.map((s) => (
          <button key={s.id} className="btn small" disabled={!!busy} onClick={() => book(s.start)}>{s.label}</button>
        ))}
      </div>
      <div className="grid2">
        <label className="field">Date<input type="date" value={date} min={todayLondon()} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field">Time<input type="time" step="900" value={time} onChange={(e) => setTime(e.target.value)} /></label>
      </div>
      <button className="btn primary" disabled={!!busy} onClick={() => book(londonToIso(date, time))}>
        {busy === "book" ? <Spinner /> : `Book visit ${fmtDate(date)} ${time}`}
      </button>
    </div>
  );
}

// ---------------- Step 1: Enquiry ----------------

function EnquiryPanel({ d, reload, job, customer, openTab }) {
  const { saveJob, saveCustomer } = useSavers(job, customer, reload);
  const [busy, run] = useBusy();
  const toast = useToast();
  const thread = d.messages.filter((m) => m.status === "received" || m.status === "sent");
  const draft = d.messages.find((m) => m.status === "draft" && m.kind === "reply");
  const [draftText, setDraftText] = useState(draft?.body ?? "");
  const [incoming, setIncoming] = useState("");
  const [booking, setBooking] = useState(false);
  useEffect(() => setDraftText(draft?.body ?? ""), [draft?.id, draft?.body]);
  const missing = job.missing_fields ?? [];
  const isChat = job.source === "whatsapp" || job.source === "sms";
  const visit = d.visits.find((v) => v.status !== "cancelled");

  const send = () => run("send", async () => {
    const r = await sb.action("send-message", { messageId: draft.id, body: draftText });
    if (r.openLink) window.open(r.openLink, "_blank");
    await reload();
    toast(r.sent ? "Reply sent" : "Opened your messaging app with the reply ready");
  });
  const regenerate = () => run("regen", async () => { await sb.action("analyse", { jobId: job.id }); await reload(); }, "New draft ready");
  const addIncoming = () => run("in", async () => {
    await sb.action("add-incoming", { jobId: job.id, text: incoming });
    setIncoming("");
    await reload();
  }, "Reply added and new draft written");
  const closeLost = () => {
    const reason = window.prompt("Why is this enquiry closed? (e.g. went elsewhere, too far, not our work)");
    if (reason !== null) saveJob({ status: "lost", lost_reason: reason || null });
  };

  return (
    <>
      {job.urgency === "emergency" && (
        <div className="banner amber"><strong>Emergency</strong>{customer.phone ? <a href={`tel:${customer.phone}`}>Call {customer.phone} now</a> : "No phone number yet"}</div>
      )}

      <div className="thread">
        {thread.length === 0 && <span className="small muted">No messages yet.</span>}
        {thread.map((m) => (
          <div key={m.id} className={`bubble ${m.direction}`}>
            {m.subject && m.direction === "in" ? <strong>{m.subject}{"\n"}</strong> : null}
            {m.body}
            <span className="meta">{m.direction === "in" ? "Customer" : "You"} · {fmtDateTime(m.received_at || m.sent_at || m.created_at)}</span>
          </div>
        ))}
      </div>

      {isChat && (
        <div className="card">
          <h2>Customer replied on {SOURCE_CHIP[job.source][0]}?</h2>
          <textarea className="input" rows={3} value={incoming} onChange={(e) => setIncoming(e.target.value)} placeholder="Paste their reply here" />
          <button className="btn" disabled={!incoming.trim() || !!busy} onClick={addIncoming}>{busy === "in" ? <Spinner /> : "Add reply and draft an answer"}</button>
        </div>
      )}

      {draft && (
        <div className="card accent">
          <div className="row"><h2>Drafted reply</h2><span className="small muted">Sends by {draft.channel === "email" ? "email" : SOURCE_CHIP[draft.channel]?.[0]}</span></div>
          <label className="field">Edit before sending
            <textarea rows={9} value={draftText} onChange={(e) => setDraftText(e.target.value)} />
          </label>
          {(job.offered_slots ?? []).length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="small muted">Visit times offered (tap one if they agree by phone)</span>
              <div className="chips">
                {job.offered_slots.map((s) => (
                  <button key={s.id} className="btn small" disabled={!!busy}
                    onClick={() => run("book", async () => { await sb.action("book-visit", { jobId: job.id, startsAt: s.start }); await reload(); }, "Visit booked")}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="btn-row">
            <button className="btn" disabled={!!busy} onClick={regenerate}>{busy === "regen" ? <Spinner /> : "Rewrite"}</button>
            <button className="btn primary" style={{ flex: 2 }} disabled={!!busy || !draftText.trim()} onClick={send}>
              {busy === "send" ? <Spinner /> : "Send reply"}
            </button>
          </div>
        </div>
      )}
      {!draft && (
        <button className="btn" disabled={!!busy} onClick={regenerate}>{busy === "regen" ? <Spinner /> : "Draft a reply"}</button>
      )}

      <div className="card">
        <h2>Details</h2>
        {missing.length > 0 && <div className="chips">{missing.map((m) => <span key={m} className="chip amber">{MISSING_LABEL[m] ?? m}</span>)}</div>}
        {job.summary && <span className="small muted">{job.summary}</span>}
        <SaveField label="Name" value={customer.name} onSave={(v) => saveCustomer({ name: v })} />
        <div className="grid2">
          <SaveField label="Phone" type="tel" value={customer.phone} onSave={(v) => saveCustomer({ phone: v })} />
          <SaveField label="Email" type="email" value={customer.email} onSave={(v) => saveCustomer({ email: v?.toLowerCase() ?? null })} />
        </div>
        <SaveField label="Job" value={job.title} onSave={(v) => saveJob({ title: v })} />
        <SaveField label="Site address" value={job.site_address} onSave={(v) => saveJob({ site_address: v })} />
        <SaveField label="Postcode" value={job.postcode} onSave={(v) => saveJob({ postcode: v?.toUpperCase() ?? null })} />
        <SaveField label="Access" value={job.access_notes} onSave={(v) => saveJob({ access_notes: v })} placeholder="Side gate, through house, parking" />
        <SaveField label="Rubbish and cuttings" value={job.waste_notes} onSave={(v) => saveJob({ waste_notes: v })} placeholder="Take everything / leave logs" />
        <label className="field">Urgency
          <select value={job.urgency} onChange={(e) => saveJob({ urgency: e.target.value })}>
            <option value="emergency">Emergency</option>
            <option value="standard">Standard</option>
            <option value="flexible">Flexible</option>
          </select>
        </label>
      </div>

      {visit ? (
        <button className="btn dark block" onClick={() => openTab("visit")}>Visit booked {fmtDateTime(visit.starts_at)} → Step 2</button>
      ) : booking ? (
        <div className="card"><h2>Book the site visit</h2><BookVisitForm job={job} reload={reload} onDone={() => openTab("visit")} /></div>
      ) : (
        <button className="btn dark block" onClick={() => setBooking(true)}>Visit agreed → book it</button>
      )}
      {job.status === "open" && <button className="btn small danger" onClick={closeLost}>Close enquiry</button>}
    </>
  );
}

// ---------------- Step 2: Site visit ----------------

function Photos({ job, photos, reload }) {
  const [urls, setUrls] = useState({});
  const [busy, run] = useBusy();
  useEffect(() => { sb.photoUrls(photos.map((p) => p.storage_path)).then(setUrls).catch(() => {}); }, [photos]);
  const upload = (source) => (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (!files.length) return;
    run("up", async () => {
      for (const f of files) await sb.uploadPhoto(job.id, f, source);
      await reload();
    }, `${files.length} photo${files.length > 1 ? "s" : ""} saved`);
  };
  const del = (p) => { if (confirm("Delete this photo?")) run("del", async () => { await sb.deletePhoto(p); await reload(); }); };
  return (
    <div className="card">
      <div className="row"><h2>Job photos · {photos.length}</h2>{busy === "up" ? <Spinner /> : <span className="small muted">Saved to job file</span>}</div>
      {photos.length > 0 && (
        <div className="photos">
          {photos.map((p) => (
            <div key={p.id} className="photo">
              {urls[p.storage_path] ? <a href={urls[p.storage_path]} target="_blank" rel="noreferrer"><img src={urls[p.storage_path]} alt={`Photo from ${p.source}`} loading="lazy" /></a> : null}
              <span className="src">{p.source}</span>
              <button aria-label="Delete photo" onClick={() => del(p)}>×</button>
            </div>
          ))}
        </div>
      )}
      <div className="btn-row">
        <label className="btn primary file-btn"><Icon.camera /> Take photo
          <input type="file" accept="image/*" capture="environment" onChange={upload("camera")} />
        </label>
        <label className="btn file-btn"><Icon.gallery /> From gallery
          <input type="file" accept="image/*" multiple onChange={upload("gallery")} />
        </label>
      </div>
    </div>
  );
}

// ---------------- Email correspondence for review ----------------

const KIND_LABEL = {
  visit_confirmation: "Visit booked", visit_reminder: "Visit reminder", job_confirmation: "Job booked",
  job_reminder: "Job reminder", quote: "Quote", invoice: "Invoice",
};
const STATUS_CHIP = { sent: ["Sent", "green"], received: ["Received", "blue"], scheduled: ["Scheduled", "amber"], draft: ["Draft, not sent", ""], failed: ["Failed to send", "red"] };

export function EmailsSheet({ messages, customer, onClose }) {
  const [order, setOrder] = useState("new");
  const emails = messages
    .filter((m) => m.channel === "email")
    .map((m) => ({ ...m, when: m.received_at || m.sent_at || m.send_at || m.created_at }))
    .sort((a, b) => (order === "new" ? b.when.localeCompare(a.when) : a.when.localeCompare(b.when)));
  const others = messages.filter((m) => m.channel !== "email").length;
  return (
    <Sheet title={`Emails · ${emails.length}`} onClose={onClose}>
      <div className="row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span className="small muted">With {customer.name || customer.email || "the customer"}</span>
        <select className="input" style={{ width: "auto" }} value={order} onChange={(e) => setOrder(e.target.value)} aria-label="Order">
          <option value="new">Newest first</option>
          <option value="old">Oldest first</option>
        </select>
      </div>
      {emails.length === 0 && <span className="muted">No emails with this customer yet.</span>}
      {emails.map((m) => {
        const [label, tone] = STATUS_CHIP[m.status] ?? [m.status, ""];
        return (
          <div key={m.id} className="card" style={{ gap: 6 }}>
            <div className="chips">
              <span className={`chip ${tone}`}>{label}</span>
              {KIND_LABEL[m.kind] && <span className="chip">{KIND_LABEL[m.kind]}</span>}
              {m.calendar && <span className="chip green">Calendar invite attached</span>}
            </div>
            <strong>{m.subject || "(no subject)"}</strong>
            <span className="small muted">
              {m.direction === "in" ? `From ${m.from_addr || "customer"}` : `To ${m.to_addr || customer.email || "—"}`}
              {" · "}{m.status === "scheduled" ? `goes ${fmtDateTime(m.send_at)}` : fmtDateTime(m.when)}
            </span>
            <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.45 }}>{m.body}</div>
            {m.thread_id && (
              <a className="btn small" style={{ alignSelf: "flex-start" }} href={`https://mail.google.com/mail/#all/${m.thread_id}`} target="_blank" rel="noreferrer">Open in Gmail</a>
            )}
          </div>
        );
      })}
      {others > 0 && <span className="small muted">{others} WhatsApp or text message{others === 1 ? " is" : "s are"} on the Enquiry tab.</span>}
    </Sheet>
  );
}

function VisitPanel({ d, reload, job, customer, openTab }) {
  const { saveJob } = useSavers(job, customer, reload);
  const [busy, run] = useBusy();
  const [rescheduling, setRescheduling] = useState(false);
  const [showEmails, setShowEmails] = useState(false);
  const emailCount = d.messages.filter((m) => m.channel === "email").length;
  const visit = d.visits.find((v) => v.status !== "cancelled");
  const reminder = d.messages.find((m) => m.kind === "visit_reminder" && m.status !== "draft");
  const address = [job.site_address, job.postcode].filter(Boolean).join(", ");

  const done = () => run("done", async () => {
    if (visit) await sb.update("site_visits", visit.id, { status: "done" });
    await sb.update("jobs", job.id, { step: Math.max(job.step, 3) });
    await reload();
    openTab("spec");
  });
  const cancel = () => {
    if (!confirm("Cancel this visit? It will be removed from your calendar.")) return;
    run("cancel", async () => { await sb.action("cancel-visit", { visitId: visit.id }); await reload(); }, "Visit cancelled");
  };

  return (
    <>
      <button className="btn block" onClick={() => setShowEmails(true)}>Show all emails ({emailCount})</button>
      {showEmails && <EmailsSheet messages={d.messages} customer={customer} onClose={() => setShowEmails(false)} />}

      {visit && !rescheduling ? (
        <div className="card accent">
          <span className="small" style={{ color: "var(--green)", fontWeight: 600 }}>{visit.calendar_event_id ? "In Google Calendar" : "Not in Google Calendar (connect Google)"}</span>
          <span style={{ fontSize: 20, fontWeight: 700 }}>{fmtDateTime(visit.starts_at)}–{fmtTime(visit.ends_at)}</span>
          <span className="muted">{address || "Address not known yet"}</span>
          <div className="btn-row">
            {customer.phone ? <a className="btn" href={`tel:${customer.phone}`}>Call</a> : <button className="btn" disabled>Call</button>}
            <a className="btn" href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`} target="_blank" rel="noreferrer">Directions</a>
            <button className="btn" onClick={() => setRescheduling(true)}>Reschedule</button>
          </div>
          <button className="btn small danger" disabled={!!busy} onClick={cancel}>Cancel visit</button>
        </div>
      ) : (
        <div className="card">
          <h2>{visit ? "New visit time" : "Book the site visit"}</h2>
          <BookVisitForm job={job} reload={reload} onDone={() => setRescheduling(false)} />
          {rescheduling && <button className="btn small" onClick={() => setRescheduling(false)}>Keep the current time</button>}
        </div>
      )}

      {visit && (
        <div className="card">
          <h2>Reminders</h2>
          <div className="kv">
            <span>{fmtDateTime(visit.call_reminder_at)}</span>
            <span><strong>You:</strong> call {customer.name || "the customer"} to confirm</span>
            <span>{reminder ? fmtDateTime(reminder.send_at) : "—"}</span>
            <span><strong>Customer:</strong> reminder email {reminder ? (reminder.status === "sent" ? "sent" : customer.email ? "scheduled" : "waiting for an email address") : "not set"}</span>
          </div>
        </div>
      )}

      <Photos job={job} photos={d.photos} reload={reload} />

      <div className="card">
        <h2>On-site notes</h2>
        <SaveField label="Access" value={job.access_notes} onSave={(v) => saveJob({ access_notes: v })} />
        <SaveField label="Rubbish and cuttings" value={job.waste_notes} onSave={(v) => saveJob({ waste_notes: v })} />
        {visit && <SaveField label="Other notes" multiline value={visit.notes}
          onSave={(v) => sb.update("site_visits", visit.id, { notes: v }).then(reload)} />}
      </div>

      <button className="btn dark block" disabled={!!busy} onClick={done}>Visit done → write spec (Step 3)</button>
    </>
  );
}

// ---------------- Step 3: Specification ----------------

function FloraRow({ f, reload }) {
  const save = (patch) => sb.update("flora", f.id, patch).then(reload);
  return (
    <div className="card">
      <div className="grid2">
        <SaveField label="Ref" value={f.label} onSave={(v) => save({ label: v })} placeholder="T1" />
        <SaveField label="Size" value={f.size_note} onSave={(v) => save({ size_note: v })} placeholder="approx. 12 m" />
      </div>
      <SaveField label="Tree or plant" value={f.species} onSave={(v) => save({ species: v })} placeholder="Sycamore" />
      <SaveField label="Work" multiline rows={2} value={f.work_spec} onSave={(v) => save({ work_spec: v })} placeholder="Crown reduce by 2 m" />
      <div className="row">
        <label className="check"><input type="checkbox" checked={f.tpo_required} onChange={(e) => save({ tpo_required: e.target.checked })} />Protected (TPO or conservation area)</label>
        <button className="icon-btn" aria-label="Remove" onClick={() => confirm("Remove this tree?") && sb.remove("flora", f.id).then(reload)}><Icon.trash /></button>
      </div>
    </div>
  );
}

function SpecPanel({ d, reload, job, customer, openTab }) {
  const { saveJob } = useSavers(job, customer, reload);
  const [busy, run] = useBusy();
  const [mapLabel, mapUrl] = councilFor(job.postcode);
  const itemFor = (cat) => d.items.find((i) => i.catalogue_item_id === cat.id);
  const days = Number(job.days_on_site) || 1;

  const toggleItem = (cat, on) => run("item", async () => {
    const existing = itemFor(cat);
    if (on && !existing) {
      await sb.insertOne("job_items", {
        job_id: job.id, catalogue_item_id: cat.id, kind: cat.kind, description: cat.name, unit: cat.unit,
        quantity: cat.unit === "day" ? days : 1, unit_cost: cat.owned ? 0 : (cat.default_cost ?? 0),
        sort: cat.kind === "equipment" ? 20 : 30,
      });
    } else if (!on && existing) {
      await sb.remove("job_items", existing.id);
    }
    await reload();
  });

  const setPermission = (patch) => {
    const next = { ...job, ...patch };
    if (patch.permission_submitted_on !== undefined || patch.conservation_area !== undefined || patch.tpo_status !== undefined) {
      if (next.permission_submitted_on && next.conservation_area === "yes" && !["required", "applied"].includes(next.tpo_status)) {
        patch.earliest_start = addDays(next.permission_submitted_on, 42); // 6 weeks' notice
      }
    }
    saveJob(patch);
  };

  const toQuote = () => run("q", async () => {
    // Make sure there is a labour line priced from the rate card.
    if (!d.items.some((i) => i.kind === "labour")) {
      const card = d.rateCards.find((r) => r.id === job.rate_card_id) ?? d.rateCards[0];
      await sb.insertOne("job_items", {
        job_id: job.id, kind: "labour", description: `Day rate, crew of ${job.crew_size || 2}`,
        unit: "day", quantity: days, unit_cost: card?.day_rate ?? 0, sort: 10,
      });
      if (!job.rate_card_id && card) await sb.update("jobs", job.id, { rate_card_id: card.id });
    }
    await sb.update("jobs", job.id, { step: Math.max(job.step, 4) });
    await reload();
    openTab("quote");
  });

  const addFlora = () => run("add", async () => {
    await sb.insertOne("flora", { job_id: job.id, label: `T${d.flora.length + 1}`, sort: d.flora.length });
    await reload();
  });

  const equipment = d.catalogue.filter((c) => c.kind === "equipment");
  const materials = d.catalogue.filter((c) => c.kind === "material");

  return (
    <>
      <div className="section-head"><h2>Trees and plants to treat</h2><button className="btn small" onClick={addFlora}>+ Add</button></div>
      {d.flora.length === 0 && <span className="small muted">None added yet.</span>}
      {d.flora.map((f) => <FloraRow key={f.id} f={f} reload={reload} />)}

      <div className="card">
        <h2>Protection and permissions</h2>
        <div className="grid2">
          <label className="field">Tree Preservation Order
            <select value={job.tpo_status} onChange={(e) => setPermission({ tpo_status: e.target.value })}>
              <option value="unknown">Not checked</option>
              <option value="not_required">Not required</option>
              <option value="required">Required</option>
              <option value="applied">Applied</option>
              <option value="granted">Granted</option>
              <option value="refused">Refused</option>
            </select>
          </label>
          <label className="field">Conservation area
            <select value={job.conservation_area} onChange={(e) => setPermission({ conservation_area: e.target.value })}>
              <option value="unknown">Not checked</option>
              <option value="no">No</option>
              <option value="yes">Yes – 6 weeks' notice</option>
            </select>
          </label>
          <label className="field">Application / notice sent
            <input type="date" value={job.permission_submitted_on ?? ""} onChange={(e) => setPermission({ permission_submitted_on: e.target.value || null })} />
          </label>
          <label className="field">Earliest start
            <input type="date" value={job.earliest_start ?? ""} onChange={(e) => saveJob({ earliest_start: e.target.value || null })} />
          </label>
        </div>
        <label className="field">Nesting bird check
          <select value={job.nesting_check} onChange={(e) => saveJob({ nesting_check: e.target.value })}>
            <option value="not_needed">Not needed (outside March–August)</option>
            <option value="required">Needed before work</option>
            <option value="done">Done</option>
          </select>
        </label>
        <a className="small" href={mapUrl} target="_blank" rel="noreferrer">Check the {mapLabel}</a>
      </div>

      <div className="card">
        <h2>Equipment</h2>
        {equipment.map((c) => (
          <label key={c.id} className="check">
            <input type="checkbox" checked={!!itemFor(c)} onChange={(e) => toggleItem(c, e.target.checked)} />
            {c.name}<span className="small muted" style={{ marginLeft: "auto" }}>{c.owned ? "own" : "hire"}</span>
          </label>
        ))}
      </div>

      <div className="card">
        <h2>Materials and labour</h2>
        {materials.map((c) => (
          <label key={c.id} className="check">
            <input type="checkbox" checked={!!itemFor(c)} onChange={(e) => toggleItem(c, e.target.checked)} />{c.name}
          </label>
        ))}
        <div className="grid2">
          <SaveField label="Crew size" type="number" value={job.crew_size} onSave={(v) => saveJob({ crew_size: v ? Number(v) : null })} />
          <SaveField label="Days on site" type="number" value={job.days_on_site} onSave={(v) => saveJob({ days_on_site: v ? Number(v) : null })} />
        </div>
      </div>

      <button className="btn dark block" disabled={!!busy} onClick={toQuote}>Build quote (Step 4)</button>
    </>
  );
}

// ---------------- Step 4: Quote and questions ----------------

const KINDS = [
  ["labour", "Labour"], ["equipment", "Equipment hire"], ["material", "Materials"], ["permission", "Permissions"], ["other", "Other"],
];

function ItemRow({ item, reload }) {
  const [v, setV] = useState(item);
  useEffect(() => setV(item), [item]);
  const commit = (k) => () => {
    if (String(v[k]) !== String(item[k])) sb.update("job_items", item.id, { [k]: k === "description" ? v[k] : Number(v[k]) || 0 }).then(reload);
  };
  return (
    <div className="line-item">
      <input className="input" aria-label="Description" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} onBlur={commit("description")} />
      <input className="input" aria-label="Quantity" inputMode="decimal" value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} onBlur={commit("quantity")} />
      <input className="input" aria-label="Unit price £" inputMode="decimal" value={v.unit_cost} onChange={(e) => setV({ ...v, unit_cost: e.target.value })} onBlur={commit("unit_cost")} />
      <button className="icon-btn" aria-label="Remove line" onClick={() => sb.remove("job_items", item.id).then(reload)}><Icon.trash /></button>
    </div>
  );
}

function Questions({ job, questions, step, reload, title, checklist }) {
  const [q, setQ] = useState("");
  const list = questions.filter((x) => x.step === step);
  const add = async () => { if (!q.trim()) return; await sb.insertOne("job_questions", { job_id: job.id, step, question: q.trim() }); setQ(""); reload(); };
  return (
    <div className="card">
      <h2>{title}</h2>
      {list.length === 0 && <span className="small muted">None yet.</span>}
      {list.map((x) => (
        <div key={x.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="row">
            <label className="check" style={{ flex: 1 }}>
              <input type="checkbox" checked={x.done} onChange={(e) => sb.update("job_questions", x.id, { done: e.target.checked }).then(reload)} />
              <span style={{ textDecoration: x.done ? "line-through" : "none" }}>{x.question}</span>
            </label>
            <button className="icon-btn" aria-label="Remove" onClick={() => sb.remove("job_questions", x.id).then(reload)}><Icon.trash /></button>
          </div>
          {!checklist && <SaveField label="Answer" value={x.answer} onSave={(v) => sb.update("job_questions", x.id, { answer: v }).then(reload)} />}
        </div>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={checklist ? "Add something to check" : "Add a customer question"} />
        <button className="btn" onClick={add}>Add</button>
      </div>
    </div>
  );
}

function QuotePanel({ d, reload, job, customer, openTab }) {
  const { saveJob } = useSavers(job, customer, reload);
  const [busy, run] = useBusy();
  const [newKind, setNewKind] = useState("other");
  const vatRate = Number(d.settings?.vat_rate ?? 20);
  const subtotal = d.items.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_cost), 0);
  const vat = Math.round(subtotal * vatRate) / 100;
  const latest = d.quotes[0];

  const changeCard = (id) => run("card", async () => {
    await sb.update("jobs", job.id, { rate_card_id: id || null });
    const card = d.rateCards.find((r) => r.id === id);
    if (card?.day_rate != null) {
      for (const it of d.items.filter((i) => i.kind === "labour" && i.unit === "day")) {
        await sb.update("job_items", it.id, { unit_cost: card.day_rate });
      }
    }
    await reload();
  });
  const addLine = () => run("add", async () => {
    await sb.insertOne("job_items", { job_id: job.id, kind: newKind, description: KINDS.find((k) => k[0] === newKind)[1], quantity: 1, unit_cost: 0, sort: 50 });
    await reload();
  });
  const sendQuote = () => run("send", async () => {
    const r = await sb.action("send-quote", { jobId: job.id });
    await reload();
    return r;
  }).then((r) => r && (r.sent ? null : alert(`Quote saved but not emailed: ${r.reason}`)));
  const accept = () => run("acc", async () => {
    if (latest) await sb.update("quotes", latest.id, { status: "accepted", accepted_at: new Date().toISOString() });
    await sb.update("jobs", job.id, { step: 5 });
    await reload();
    openTab("book");
  });
  const decline = () => {
    const reason = window.prompt("Reason the quote was turned down?");
    if (reason === null) return;
    run("dec", async () => {
      if (latest) await sb.update("quotes", latest.id, { status: "declined" });
      await sb.update("jobs", job.id, { status: "lost", lost_reason: reason || "Quote declined" });
      await reload();
    });
  };

  return (
    <>
      <label className="field">Rate card
        <select value={job.rate_card_id ?? ""} onChange={(e) => changeCard(e.target.value)}>
          <option value="">Choose…</option>
          {d.rateCards.map((r) => <option key={r.id} value={r.id}>{r.name}{r.day_rate != null ? ` – ${money(r.day_rate)}/day` : " – set rate in Settings"}{r.notes ? `, ${r.notes}` : ""}</option>)}
        </select>
      </label>

      <div className="card">
        <h2>Costing</h2>
        <div className="line-item small muted"><span>Item</span><span>Qty</span><span>£ each</span><span /></div>
        {KINDS.map(([k, label]) => {
          const rows = d.items.filter((i) => i.kind === k);
          if (!rows.length) return null;
          return (
            <div key={k} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="group-label">{label}</span>
              {rows.map((i) => <ItemRow key={i.id} item={i} reload={reload} />)}
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 8 }}>
          <select className="input" value={newKind} onChange={(e) => setNewKind(e.target.value)} aria-label="Line type">
            {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button className="btn" style={{ whiteSpace: "nowrap", flex: "none" }} onClick={addLine}>Add line</button>
        </div>
        <div className="totals">
          <div className="row"><span>Subtotal</span><span>{money(subtotal)}</span></div>
          <div className="row"><span>VAT {vatRate}%</span><span>{money(vat)}</span></div>
          <div className="row grand"><span>Total</span><span>{money(subtotal + vat)}</span></div>
        </div>
        <span className="small muted">Prices here are for this job only. Change standard prices in Settings.</span>
      </div>

      <Questions job={job} questions={d.questions} step={4} reload={reload} title="Customer questions" />

      {latest && <span className="small muted">Quote v{latest.version} {latest.status} {fmtDate(latest.sent_at || latest.created_at)} · {money(latest.total)}</span>}
      <button className="btn primary block" disabled={!!busy || !d.items.length} onClick={sendQuote}>{busy === "send" ? <Spinner /> : latest ? "Email updated quote" : "Email quote"}</button>
      <div className="btn-row">
        <button className="btn" disabled={!!busy} onClick={decline}>Declined</button>
        <button className="btn dark" style={{ flex: 2 }} disabled={!!busy} onClick={accept}>Quote accepted → schedule (Step 5)</button>
      </div>
    </>
  );
}

// ---------------- Step 5: Schedule job and invoice ----------------

function BookPanel({ d, reload, job }) {
  const [busy, run] = useBusy();
  const min = job.earliest_start && job.earliest_start > todayLondon() ? job.earliest_start : todayLondon();
  const days = Math.max(1, Math.ceil(Number(job.days_on_site) || 1));
  const [start, setStart] = useState(job.job_start ?? min);
  const [end, setEnd] = useState(job.job_end ?? addDays(job.job_start ?? min, days - 1));
  const book = () => run("book", async () => {
    await sb.action("book-job", { jobId: job.id, startDate: start, endDate: end < start ? start : end });
    await reload();
  }, "Job booked, customer emailed and reminder scheduled");
  const invoice = () => run("inv", async () => {
    const r = await sb.action("create-invoice", { jobId: job.id, send: true });
    await reload();
    if (!r.sent) alert(`Invoice ${r.invoice?.number} saved but not emailed: ${r.reason}`);
  });
  const markPaid = (inv) => run("paid", async () => {
    await sb.update("invoices", inv.id, { status: "paid", paid_on: todayLondon() });
    await reload();
  }, "Marked as paid");

  return (
    <>
      {job.earliest_start && (
        <div className="banner blue">
          <strong>{job.conservation_area === "yes" ? "Conservation area notice" : "Council permission"}{job.permission_submitted_on ? ` sent ${fmtDate(job.permission_submitted_on)}` : ""}</strong>
          <span>Earliest legal start: {fmtDate(job.earliest_start)}</span>
        </div>
      )}
      {job.nesting_check === "required" && <div className="banner amber">Nesting bird check needed before work starts.</div>}

      <div className="card">
        <h2>{job.job_start ? `Booked ${fmtDate(job.job_start)}${job.job_end && job.job_end !== job.job_start ? ` – ${fmtDate(job.job_end)}` : ""}` : "Job dates"}</h2>
        <div className="grid2">
          <label className="field">First day<input type="date" min={min} value={start} onChange={(e) => { setStart(e.target.value); if (end < e.target.value) setEnd(addDays(e.target.value, days - 1)); }} /></label>
          <label className="field">Last day<input type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        </div>
        <span className="small muted">Booking adds the job to Google Calendar, emails the customer a confirmation and schedules a reminder 2 days before.</span>
        <button className="btn primary" disabled={!!busy} onClick={book}>{busy === "book" ? <Spinner /> : job.job_start ? "Change booking" : `Book ${fmtDate(start)}${end !== start ? ` – ${fmtDate(end)}` : ""}`}</button>
      </div>

      <Questions job={job} questions={d.questions} step={5} reload={reload} title="Questions before the job" checklist />

      <div className="card">
        <h2>Invoice</h2>
        {d.invoices.length === 0 && <span className="small muted">No invoice yet. Costs come from the Step 4 lines (labour, equipment hire, materials).</span>}
        {d.invoices.map((inv) => (
          <div key={inv.id} className="row">
            <span>{inv.number} · {money(inv.total)} · {inv.status}{inv.due_on && inv.status !== "paid" ? `, due ${fmtDate(inv.due_on)}` : ""}</span>
            {inv.status !== "paid" && <button className="btn small" onClick={() => markPaid(inv)}>Paid</button>}
          </div>
        ))}
        <button className="btn dark" disabled={!!busy || !d.items.length} onClick={invoice}>{busy === "inv" ? <Spinner /> : "Job done → email invoice"}</button>
      </div>
    </>
  );
}
