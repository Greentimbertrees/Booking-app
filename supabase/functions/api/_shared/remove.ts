// Taking jobs off the board. Nothing is deleted from Gmail.
import { admin, HttpError } from "./supa.ts";
import * as g from "./google.ts";
import { londonDate } from "./time.ts";

// ---------------- Removing jobs from the app ----------------

/**
 * Takes a job off the board and out of the app. Nothing is deleted from Gmail.
 * Future calendar entries the app made for it are removed, scheduled reminders are dropped,
 * and its Gmail threads are remembered so further emails in them stay off the board.
 */
export async function removeJob(jobId: string) {
  const { data: job } = await admin.from("jobs")
    .select("id, customer_id, job_start, job_calendar_event_id, invoices(id), site_visits(id, starts_at, status, calendar_event_id, call_event_id), messages(thread_id)")
    .eq("id", jobId).maybeSingle();
  if (!job) return { removed: false, reason: "not found" };
  if ((job.invoices ?? []).length) {
    throw new HttpError(400, "A job with an invoice can't be removed. Close it instead.");
  }

  const threads = [...new Set((job.messages ?? []).map((m: any) => m.thread_id).filter(Boolean))];
  if (threads.length) {
    await admin.from("removed_threads").upsert(threads.map((t) => ({ thread_id: t })), { onConflict: "thread_id" });
  }

  if (await g.isConnected()) {
    const now = Date.now();
    for (const v of job.site_visits ?? []) {
      if (v.status === "cancelled" || new Date(v.starts_at).getTime() < now) continue;
      if (v.calendar_event_id) await g.deleteEvent(v.calendar_event_id);
      if (v.call_event_id) await g.deleteEvent(v.call_event_id);
    }
    if (job.job_calendar_event_id && job.job_start && job.job_start >= londonDate(new Date())) {
      await g.deleteEvent(job.job_calendar_event_id);
    }
  }

  const { data: photos } = await admin.from("photos").select("storage_path").eq("job_id", jobId);
  if (photos?.length) await admin.storage.from("job-photos").remove(photos.map((p: any) => p.storage_path));

  // Messages, visits, plants, photos, costings, quotes and questions go with the job.
  const { error } = await admin.from("jobs").delete().eq("id", jobId);
  if (error) throw error;

  if (job.customer_id) {
    const { count } = await admin.from("jobs").select("id", { count: "exact", head: true }).eq("customer_id", job.customer_id);
    if (!count) await admin.from("customers").delete().eq("id", job.customer_id);
  }
  return { removed: true };
}
