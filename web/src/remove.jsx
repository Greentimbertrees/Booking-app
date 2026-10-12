import * as sb from "./sb.js";
import { Sheet, Spinner, useBusy, useToast } from "./ui.jsx";

/** Confirms and removes one or more jobs from the app. Emails stay in Gmail. */
export function RemoveJobsSheet({ jobs, onClose, onRemoved }) {
  const [busy, run] = useBusy();
  const toast = useToast();
  const n = jobs.length;
  const fromEmail = jobs.some((j) => j.source === "email");
  const booked = jobs.some((j) => (j.site_visits ?? []).some((v) => v.status !== "cancelled") || j.job_start);
  const names = jobs.slice(0, 4).map((j) => j.customers?.name || j.customers?.email || j.customers?.phone || "New enquiry");

  const remove = () => run("remove", async () => {
    const r = await sb.action("remove-jobs", { jobIds: jobs.map((j) => j.id) });
    if (r.skipped?.length) toast(`Removed ${r.removed}. ${r.skipped.length} kept: ${r.skipped[0]}`, "error");
    else toast(r.removed === 1 ? "Removed from the app" : `${r.removed} removed from the app`);
    onRemoved(r);
  });

  return (
    <Sheet title={n === 1 ? "Remove from the app?" : `Remove ${n} from the app?`} onClose={busy ? () => {} : onClose}>
      <div className="card">
        <span>{names.join(", ")}{n > names.length ? ` and ${n - names.length} more` : ""}</span>
        <ul className="plain-list">
          {fromEmail && <li>The emails stay in your Gmail. Only the app's copy goes.</li>}
          {fromEmail && <li>Further emails in the same conversation won't come back onto the board.</li>}
          <li>Drafts, notes, photos and costings for {n === 1 ? "it" : "them"} are deleted from the app.</li>
          {booked && <li>Upcoming visits or job days booked from {n === 1 ? "it" : "them"} come off your calendar.</li>}
        </ul>
      </div>
      <div className="btn-row">
        <button className="btn" onClick={onClose} disabled={!!busy}>Keep</button>
        <button className="btn danger-fill" onClick={remove} disabled={!!busy}>
          {busy ? <><Spinner /> Removing…</> : n === 1 ? "Remove" : `Remove ${n}`}
        </button>
      </div>
    </Sheet>
  );
}
