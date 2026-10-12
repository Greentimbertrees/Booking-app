import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import * as sb from "./sb.js";
import {
  BottomNav, fmtDate, fmtDateTime, fmtTime, go, Icon, MISSING_LABEL, Sheet, SOURCE_CHIP, Spinner, STEPS,
  ToastProvider, todayLondon, addDays, useBusy, useRoute, useToast,
} from "./ui.jsx";
import { JobPage } from "./job.jsx";
import { SettingsPage } from "./settings.jsx";
import { RemoveJobsSheet } from "./remove.jsx";
import "./app.css";

// ---------------- Sign in ----------------

function Login({ linkError }) {
  const [email, setEmail] = useState(() => localStorage.getItem("gt.email") || "");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, run] = useBusy();

  const send = (e) => {
    e.preventDefault();
    run("send", async () => {
      localStorage.setItem("gt.email", email.trim());
      await sb.sendSignInEmail(email.trim());
      setSent(true);
    });
  };
  const verify = (e) => {
    e.preventDefault();
    run("verify", () => sb.verifyCode(email.trim(), code.trim()));
  };

  return (
    <div className="login">
      <span className="muted">Green Timber Trees</span>
      <h1>Jobs</h1>
      {linkError && <div className="banner amber">That sign-in link didn't work: {linkError}. Send a new one below.</div>}
      {!sent ? (
        <form onSubmit={send} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label className="field">Your email
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button className="btn primary block" disabled={busy === "send"}>{busy === "send" ? <Spinner /> : "Email me a sign-in link"}</button>
        </form>
      ) : (
        <form onSubmit={verify} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="banner green">Check {email} and tap the sign-in link. Open it on this phone so you stay signed in here.</div>
          <label className="field">Or type the code from the email
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <button className="btn block" disabled={!code || busy === "verify"}>{busy === "verify" ? <Spinner /> : "Sign in with code"}</button>
          <button type="button" className="btn small" onClick={() => setSent(false)}>Use a different email</button>
        </form>
      )}
    </div>
  );
}

// ---------------- New enquiry (pasted from WhatsApp, SMS or a call) ----------------

function NewEnquiry({ onClose }) {
  const [f, setF] = useState({ channel: "whatsapp", name: "", phone: "", email: "", text: "" });
  const [busy, run] = useBusy();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    run("save", async () => {
      const r = await sb.action("new-enquiry", f);
      onClose();
      go(`/job/${r.jobId}`);
    });
  };
  return (
    <Sheet title="New enquiry" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label className="field">Came in by
          <select value={f.channel} onChange={set("channel")}>
            <option value="whatsapp">WhatsApp</option>
            <option value="sms">Text message</option>
            <option value="phone">Phone call</option>
            <option value="email">Email (not in Gmail)</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="field">Message, or notes from the call
          <textarea rows={6} required value={f.text} onChange={set("text")} placeholder="Paste the customer's message here" />
        </label>
        <div className="grid2">
          <label className="field">Name<input value={f.name} onChange={set("name")} /></label>
          <label className="field">Phone<input type="tel" value={f.phone} onChange={set("phone")} /></label>
        </div>
        <label className="field">Email<input type="email" value={f.email} onChange={set("email")} /></label>
        <span className="small muted">The app reads the message, picks out the details and drafts a reply offering visit times.</span>
        <button className="btn primary block" disabled={busy === "save"}>{busy === "save" ? <><Spinner /> Reading message…</> : "Save and draft reply"}</button>
      </form>
    </Sheet>
  );
}

// ---------------- Jobs list ----------------

function nextLine(job) {
  const drafts = (job.messages ?? []).filter((m) => m.status === "draft" && m.direction === "out");
  const visit = (job.site_visits ?? []).filter((v) => v.status !== "cancelled").sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  switch (job.step) {
    case 1:
      if (drafts.length) return ["Reply drafted · Review", true];
      if ((job.offered_slots ?? []).length) return ["Visit times offered · waiting", false];
      return ["Waiting for customer", false];
    case 2:
      return visit ? [`Visit ${fmtDateTime(visit.starts_at)}`, true] : ["Book a visit", true];
    case 3:
      return ["Write the specification", true];
    case 4: {
      const q = (job.quotes ?? []).sort((a, b) => b.version - a.version)[0];
      return q ? [`Quote ${q.status} ${fmtDate(q.sent_at || q.created_at)}`, false] : ["Build the quote", true];
    }
    case 5:
      return job.job_start ? [`Booked ${fmtDate(job.job_start)}`, false] : ["Pick a job date", true];
    default:
      return ["", false];
  }
}

function JobCard({ job, selecting, selected, onToggle }) {
  const [src, tone] = SOURCE_CHIP[job.source] ?? ["Other", ""];
  const [next, strong] = nextLine(job);
  const c = job.customers ?? {};
  const locked = (job.invoices ?? []).length > 0;
  const body = (
    <>
      <div className="row">
        <span className="who">{c.name || c.email || c.phone || "New enquiry"}</span>
        <span className={`chip ${tone}`}>{src}</span>
      </div>
      <span className="what">{[job.title || job.summary, job.postcode].filter(Boolean).join(" · ") || "Details still to come"}</span>
      <div className="chips">
        {job.urgency === "emergency" && <span className="chip red">Emergency – call now</span>}
        {job.step === 1 && (job.missing_fields ?? []).slice(0, 3).map((m) => <span key={m} className="chip amber">{MISSING_LABEL[m] ?? m}</span>)}
        {job.conservation_area === "yes" && <span className="chip blue">Conservation area</span>}
        {["required", "applied"].includes(job.tpo_status) && <span className="chip blue">TPO</span>}
        {job.step === 1 && !(job.missing_fields ?? []).length && <span className="chip green">All details collected</span>}
      </div>
      {next && <span className={strong ? "next" : "small muted"}>{next}</span>}
    </>
  );
  if (!selecting) return <a className="card job-card" href={`#/job/${job.id}`}>{body}</a>;
  return (
    <label className={`card job-card selectable ${selected ? "selected" : ""} ${locked ? "locked" : ""}`}>
      <input type="checkbox" checked={selected} disabled={locked} onChange={() => onToggle(job.id)}
        aria-label={`Select ${c.name || c.email || c.phone || "enquiry"}`} />
      <div className="card-body">
        {body}
        {locked && <span className="small muted">Has an invoice, so it stays</span>}
      </div>
    </label>
  );
}

function JobsPage({ query }) {
  const step = Math.min(5, Math.max(1, Number(query.get("step")) || 1));
  const showDone = query.get("done") === "1";
  const [jobs, setJobs] = useState(null);
  const [adding, setAdding] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, run] = useBusy();
  const toast = useToast();

  const load = async () => {
    const filter = showDone ? "status=neq.open" : `status=eq.open&step=eq.${step}`;
    const rows = await sb.select("jobs",
      `select=*,customers(name,email,phone),messages(status,direction),site_visits(starts_at,status),quotes(version,status,sent_at,created_at),invoices(id)&${filter}&order=updated_at.desc&limit=100`);
    rows.sort((a, b) => (a.urgency === "emergency") === (b.urgency === "emergency") ? 0 : a.urgency === "emergency" ? -1 : 1);
    setJobs(rows);
  };
  useEffect(() => {
    setJobs(null);
    setSelecting(false);
    setPicked(new Set());
    load().catch((e) => toast(e.message, "error"));
  }, [step, showDone]);

  const sync = () => run("sync", async () => {
    const r = await sb.action("sync");
    await load();
    if (r.skipped) toast("Connect Google in Settings to read Gmail");
    else toast(`Checked Gmail: ${r.created ?? 0} new, ${r.updated ?? 0} replies`);
  });

  const removable = (jobs ?? []).filter((j) => !(j.invoices ?? []).length);
  const toggle = (id) => setPicked((p) => {
    const n = new Set(p);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const allPicked = removable.length > 0 && removable.every((j) => picked.has(j.id));
  const pickAll = () => setPicked(allPicked ? new Set() : new Set(removable.map((j) => j.id)));
  const stopSelecting = () => { setSelecting(false); setPicked(new Set()); };
  const pickedJobs = (jobs ?? []).filter((j) => picked.has(j.id));

  const s = STEPS[step - 1];
  return (
    <>
      <div className="top">
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="eyebrow">Green Timber Trees</span>
          <h1>Jobs</h1>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="icon-btn" onClick={sync} aria-label="Check Gmail now" disabled={busy === "sync"}>
            {busy === "sync" ? <Spinner /> : <Icon.sync />}
          </button>
          <button className="btn primary pill" onClick={() => setAdding(true)}><Icon.plus />New enquiry</button>
        </div>
      </div>
      <nav className="tabs" aria-label="Job steps">
        {STEPS.map((t) => (
          <a key={t.n} href={`#/jobs?step=${t.n}`} className={`tab ${!showDone && t.n === step ? "on" : ""}`}
            aria-current={!showDone && t.n === step ? "page" : undefined}>{t.label}</a>
        ))}
      </nav>
      <div className={`page ${selecting ? "with-action-bar" : ""}`}>
        <div className="section-head">
          <h2>{showDone ? "Finished and closed" : s.long}</h2>
          {jobs?.length ? (
            selecting ? (
              <div className="head-actions">
                <button className="link-btn" onClick={pickAll}>{allPicked ? "Clear" : "Select all"}</button>
                <button className="link-btn" onClick={stopSelecting}>Done</button>
              </div>
            ) : (
              <button className="link-btn" onClick={() => setSelecting(true)}>Select</button>
            )
          ) : (
            <span className="small muted">{step === 1 && !showDone ? "Gmail · WhatsApp · SMS" : ""}</span>
          )}
        </div>
        {jobs === null && <div className="empty"><Spinner /></div>}
        {jobs?.length === 0 && <div className="empty">Nothing here at the moment.</div>}
        {jobs?.map((j) => <JobCard key={j.id} job={j} selecting={selecting} selected={picked.has(j.id)} onToggle={toggle} />)}
        {!selecting && (
          <a className="small" href={showDone ? "#/jobs?step=1" : "#/jobs?done=1"} style={{ textAlign: "center" }}>
            {showDone ? "Back to open jobs" : "Show finished and closed jobs"}
          </a>
        )}
      </div>
      {selecting && (
        <div className="action-bar" role="region" aria-label="Selected jobs">
          <div className="action-bar-inner">
            <span>{picked.size ? `${picked.size} selected` : "Tap cards to select"}</span>
            <button className="btn danger-fill" disabled={!picked.size} onClick={() => setConfirming(true)}>
              <Icon.trash />Remove from app
            </button>
          </div>
        </div>
      )}
      {confirming && (
        <RemoveJobsSheet
          jobs={pickedJobs}
          onClose={() => setConfirming(false)}
          onRemoved={async () => {
            setConfirming(false);
            stopSelecting();
            await load().catch((e) => toast(e.message, "error"));
          }}
        />
      )}
      {adding && <NewEnquiry onClose={() => setAdding(false)} />}
      {!selecting && <BottomNav active="jobs" />}
    </>
  );
}

// ---------------- Calendar (visits and jobs from the app) ----------------

function CalendarPage() {
  const [items, setItems] = useState(null);
  const toast = useToast();
  useEffect(() => {
    (async () => {
      const from = new Date(Date.now() - 12 * 3600_000).toISOString();
      const visits = await sb.select("site_visits", `select=*,jobs(id,title,postcode,site_address,customers(name,phone))&status=neq.cancelled&starts_at=gte.${from}&order=starts_at`);
      const jobs = await sb.select("jobs", `select=id,title,postcode,job_start,job_end,customers(name,phone)&job_start=gte.${addDays(todayLondon(), -1)}&order=job_start`);
      const list = [
        ...visits.map((v) => ({ key: "v" + v.id, when: v.starts_at, day: v.starts_at, type: "Site visit", job: v.jobs, time: fmtTime(v.starts_at) })),
        ...jobs.map((j) => ({ key: "j" + j.id, when: j.job_start + "T07:00:00Z", day: j.job_start, type: j.job_end && j.job_end !== j.job_start ? `Job until ${fmtDate(j.job_end)}` : "Job", job: j, time: "All day" })),
      ].sort((a, b) => a.when.localeCompare(b.when));
      setItems(list);
    })().catch((e) => toast(e.message, "error"));
  }, []);

  const groups = useMemo(() => {
    const g = new Map();
    for (const it of items ?? []) {
      const d = fmtDate(it.day);
      if (!g.has(d)) g.set(d, []);
      g.get(d).push(it);
    }
    return [...g.entries()];
  }, [items]);

  return (
    <>
      <div className="top"><div><span className="eyebrow">Coming up</span><h1>Calendar</h1></div></div>
      <div className="page">
        {items === null && <div className="empty"><Spinner /></div>}
        {items?.length === 0 && <div className="empty">No visits or jobs booked yet.</div>}
        {groups.map(([day, list]) => (
          <div key={day} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>{day}</h2>
            {list.map((it) => (
              <a key={it.key} className="card job-card" href={`#/job/${it.job?.id}`}>
                <div className="row"><span className="who">{it.job?.customers?.name || "Customer"}</span><span className="chip">{it.time}</span></div>
                <span className="what">{it.type} · {[it.job?.title, it.job?.postcode].filter(Boolean).join(" · ")}</span>
              </a>
            ))}
          </div>
        ))}
        <span className="small muted">Everything here is also in your Google Calendar, with call reminders.</span>
      </div>
      <BottomNav active="calendar" />
    </>
  );
}

// ---------------- Camera (quick photos into a job) ----------------

function CameraPage() {
  const [jobs, setJobs] = useState([]);
  const [jobId, setJobId] = useState(localStorage.getItem("gt.cameraJob") || "");
  const [count, setCount] = useState(0);
  const [busy, run] = useBusy();
  const toast = useToast();
  useEffect(() => {
    sb.select("jobs", "select=id,title,postcode,step,customers(name)&status=in.(open,won)&order=updated_at.desc&limit=50")
      .then(setJobs).catch((e) => toast(e.message, "error"));
  }, []);
  const choose = (e) => { setJobId(e.target.value); localStorage.setItem("gt.cameraJob", e.target.value); };
  const upload = (source) => (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (!files.length || !jobId) return;
    run("up", async () => {
      for (const f of files) await sb.uploadPhoto(jobId, f, source);
      setCount((c) => c + files.length);
    }, `${files.length} photo${files.length > 1 ? "s" : ""} saved to the job`);
  };
  return (
    <>
      <div className="top"><div><span className="eyebrow">Photos</span><h1>Camera</h1></div></div>
      <div className="page">
        <label className="field">Save photos to
          <select value={jobId} onChange={choose}>
            <option value="">Choose a job…</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{[j.customers?.name, j.title, j.postcode].filter(Boolean).join(" · ") || "Job"}</option>)}
          </select>
        </label>
        <div className="btn-row">
          <label className={`btn primary file-btn ${!jobId ? "disabled" : ""}`} aria-disabled={!jobId}>
            <Icon.camera /> Take photo
            <input type="file" accept="image/*" capture="environment" disabled={!jobId} onChange={upload("camera")} />
          </label>
          <label className="btn file-btn" aria-disabled={!jobId}>
            <Icon.gallery /> From gallery
            <input type="file" accept="image/*" multiple disabled={!jobId} onChange={upload("gallery")} />
          </label>
        </div>
        {busy === "up" && <div className="banner green"><Spinner /> Uploading…</div>}
        {count > 0 && <span className="small muted">{count} saved this session. </span>}
        {jobId && <a className="btn" href={`#/job/${jobId}?tab=visit`}>Open this job</a>}
      </div>
      <BottomNav active="camera" />
    </>
  );
}

// ---------------- App shell ----------------

function App() {
  const [linkError] = useState(() => sb.handleSignInRedirect());
  const [session, setSession] = useState(() => sb.currentSession());
  const [allowed, setAllowed] = useState(null);
  const route = useRoute();

  useEffect(() => sb.onSession(setSession), []);
  useEffect(() => {
    if (!session) { setAllowed(null); return; }
    sb.select("app_users", "select=email").then((r) => setAllowed(r.length > 0)).catch(() => setAllowed(false));
  }, [session?.access_token]);

  if (!session) return <Login linkError={linkError} />;
  if (allowed === null) return <div className="empty" style={{ paddingTop: 120 }}><Spinner /></div>;
  if (!allowed) {
    return (
      <div className="login">
        <h1>No access</h1>
        <p>This email isn't on the list of people allowed to use the app. Ask the owner to add it.</p>
        <button className="btn" onClick={sb.signOut}>Sign out</button>
      </div>
    );
  }

  const [first, second] = route.parts;
  let page;
  if (first === "job" && second) page = <JobPage id={second} query={route.query} />;
  else if (first === "settings") page = <SettingsPage query={route.query} />;
  else if (first === "calendar") page = <CalendarPage />;
  else if (first === "camera") page = <CameraPage />;
  else page = <JobsPage query={route.query} />;
  return <div className="app">{page}</div>;
}

createRoot(document.getElementById("root")).render(<ToastProvider><App /></ToastProvider>);

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
