// The enquiry-to-invoice workflow used by the app actions and the timer job.
import { admin, getSettings, HttpError } from "./supa.ts";
import * as g from "./google.ts";
import { analyseConversation, Slot } from "./ai.ts";
import { addDays, formatLongDate, formatSlot, londonDate, londonToUtc, londonWeekday, timeString } from "./time.ts";

const money = (n: number) => `£${n.toFixed(2)}`;
const firstName = (name?: string | null) => (name ?? "").trim().split(/\s+/)[0] || "there";

function outwardCode(postcode?: string | null): string | null {
  if (!postcode) return null;
  const pc = postcode.toUpperCase().replace(/\s+/g, " ").trim();
  const m = pc.match(/^([A-Z]{1,2}\d[A-Z\d]?)/);
  return m ? m[1] : null;
}

// ---------------- Visit slots ----------------

export async function findSlots(postcode: string | null, count = 2): Promise<Slot[]> {
  if (!(await g.isConnected())) return [];
  const s = await getSettings();
  const dayStart = timeString(s.visit_day_start);
  const dayEnd = timeString(s.visit_day_end);
  const minutes = s.visit_minutes as number;

  const today = londonDate(new Date());
  const days: string[] = [];
  for (let i = 1; days.length < 10 && i < 20; i++) {
    const d = addDays(today, i);
    const wd = londonWeekday(londonToUtc(d, "12:00"));
    if (wd !== "Sat" && wd !== "Sun") days.push(d);
  }
  const rangeStart = londonToUtc(days[0], "00:00");
  const rangeEnd = londonToUtc(days[days.length - 1], "23:59");
  const busy = await g.freeBusy(rangeStart, rangeEnd);

  const { data: visits } = await admin.from("site_visits")
    .select("starts_at, status, jobs(postcode)")
    .gte("starts_at", rangeStart.toISOString()).lte("starts_at", rangeEnd.toISOString())
    .neq("status", "cancelled");
  const area = outwardCode(postcode);
  const sameAreaDays = new Set(
    (visits ?? []).filter((v: any) => area && outwardCode(v.jobs?.postcode) === area)
      .map((v: any) => londonDate(new Date(v.starts_at))),
  );

  const buffer = 30 * 60000; // travel time either side
  const candidates: { day: string; start: Date; same: boolean }[] = [];
  for (const day of days) {
    const [sh, sm] = dayStart.split(":").map(Number);
    const [eh, em] = dayEnd.split(":").map(Number);
    for (let t = sh * 60 + sm; t + minutes <= eh * 60 + em; t += 30) {
      const hhmm = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
      const start = londonToUtc(day, hhmm);
      const end = new Date(start.getTime() + minutes * 60000);
      const clash = busy.some((b) => b.start.getTime() < end.getTime() + buffer && b.end.getTime() > start.getTime() - buffer);
      if (!clash) {
        candidates.push({ day, start, same: sameAreaDays.has(day) });
        break; // first free time each day
      }
    }
  }
  candidates.sort((a, b) => (a.same === b.same ? a.start.getTime() - b.start.getTime() : a.same ? -1 : 1));
  return candidates.slice(0, count)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map((c, i) => ({ id: `s${i + 1}`, start: c.start.toISOString(), label: formatSlot(c.start) }));
}

// ---------------- Analysis and drafting ----------------

async function loadJob(jobId: string) {
  const { data: job, error } = await admin.from("jobs").select("*, customers(*)").eq("id", jobId).single();
  if (error || !job) throw new HttpError(404, "Job not found");
  return job;
}

export async function analyseJob(jobId: string, opts: { allowAutoSend?: boolean } = {}) {
  const settings = await getSettings();
  const job = await loadJob(jobId);
  const customer = job.customers;
  const { data: msgs } = await admin.from("messages").select("*").eq("job_id", jobId)
    .in("status", ["received", "sent"]).order("created_at");
  const { count: photoCount } = await admin.from("photos").select("id", { count: "exact", head: true }).eq("job_id", jobId);

  let slots: Slot[] = Array.isArray(job.offered_slots) ? job.offered_slots : [];
  const stillValid = slots.length > 0 && slots.every((s) => new Date(s.start).getTime() > Date.now() + 3600_000);
  if (!stillValid && job.step === 1) slots = await findSlots(job.postcode);
  if (job.step !== 1) slots = [];

  const analysis = await analyseConversation({
    business: settings.business_name,
    signature: settings.signature,
    channel: job.source,
    known: {
      name: customer?.name, phone: customer?.phone, email: customer?.email,
      site_address: job.site_address, postcode: job.postcode,
      access: job.access_notes, waste: job.waste_notes, step: job.step,
    },
    photosReceived: photoCount ?? 0,
    slots,
    conversation: (msgs ?? []).map((m: any) => ({
      direction: m.direction,
      when: formatSlot(new Date(m.received_at ?? m.sent_at ?? m.created_at)),
      text: (m.subject ? `Subject: ${m.subject}\n` : "") + (m.body ?? ""),
    })),
    today: formatLongDate(new Date()),
  });

  if (!analysis.is_enquiry) return { isEnquiry: false as const };

  // Fill in blanks only, so anything typed in the app is kept.
  if (customer) {
    const c: Record<string, unknown> = {};
    if (!customer.name && analysis.customer.name) c.name = analysis.customer.name;
    if (!customer.phone && analysis.customer.phone) c.phone = analysis.customer.phone;
    if (!customer.email && analysis.customer.email) c.email = analysis.customer.email.toLowerCase();
    if (Object.keys(c).length) await admin.from("customers").update(c).eq("id", customer.id);
  }
  const j: Record<string, unknown> = {
    missing_fields: analysis.missing,
    urgency: analysis.urgency,
    offered_slots: slots,
  };
  if (!job.title && analysis.title) j.title = analysis.title;
  if (analysis.summary) j.summary = analysis.summary;
  if (!job.site_address && analysis.site_address) j.site_address = analysis.site_address;
  if (!job.postcode && analysis.postcode) j.postcode = analysis.postcode.toUpperCase();
  if (!job.access_notes && analysis.access_notes) j.access_notes = analysis.access_notes;
  if (!job.waste_notes && analysis.waste_notes) j.waste_notes = analysis.waste_notes;
  await admin.from("jobs").update(j).eq("id", jobId);

  const { count: floraCount } = await admin.from("flora").select("id", { count: "exact", head: true }).eq("job_id", jobId);
  if (!floraCount && analysis.flora.length) {
    await admin.from("flora").insert(analysis.flora.map((f, i) => ({
      job_id: jobId, label: `T${i + 1}`, species: f.species, size_note: f.size, work_spec: f.work, sort: i,
    })));
  }

  let booked = false;
  if (analysis.accepted_slot_id) {
    const slot = slots.find((s) => s.id === analysis.accepted_slot_id);
    if (slot) {
      await bookVisit(jobId, slot.start);
      booked = true;
    }
  }

  // Replace any older unsent draft with the new one.
  await admin.from("messages").delete().eq("job_id", jobId).eq("status", "draft");
  let draftId: string | null = null;
  if (analysis.reply) {
    const fresh = await loadJob(jobId);
    const lastIn = [...(msgs ?? [])].reverse().find((m: any) => m.direction === "in");
    const ch = job.source === "whatsapp" || job.source === "sms" ? job.source : "email";
    const { data: draft } = await admin.from("messages").insert({
      job_id: jobId,
      channel: ch,
      direction: "out",
      status: "draft",
      kind: "reply",
      to_addr: ch === "email"
        ? (fresh.customers?.email ?? (lastIn?.channel === "email" ? lastIn?.from_addr : null))
        : (fresh.customers?.whatsapp ?? fresh.customers?.phone),
      subject: lastIn?.subject ? (lastIn.subject.startsWith("Re:") ? lastIn.subject : `Re: ${lastIn.subject}`) : `Your enquiry – ${settings.business_name}`,
      body: analysis.reply,
      thread_id: lastIn?.thread_id ?? null,
    }).select("id").single();
    draftId = draft?.id ?? null;

    if (draftId && opts.allowAutoSend && job.source === "email") {
      const { count: sentCount } = await admin.from("messages").select("id", { count: "exact", head: true })
        .eq("job_id", jobId).eq("direction", "out").eq("status", "sent");
      const allowed = (sentCount ?? 0) === 0 ? settings.auto_send_first_reply : settings.auto_send_followups;
      if (allowed) {
        await sendMessage(draftId);
        draftId = null;
      }
    }
  }
  return { isEnquiry: true as const, draftId, booked };
}

// ---------------- Sending ----------------

function ukToInternational(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits.slice(1);
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.startsWith("0")) return "44" + digits.slice(1);
  return digits;
}

export async function sendMessage(messageId: string, bodyOverride?: string) {
  const { data: m } = await admin.from("messages").select("*, jobs(*, customers(*))").eq("id", messageId).single();
  if (!m) throw new HttpError(404, "Message not found");
  const body = bodyOverride ?? m.body ?? "";
  const customer = m.jobs?.customers;

  if (m.channel === "email") {
    const to = m.to_addr || customer?.email;
    if (!to) throw new HttpError(400, "No email address for this customer yet");
    const { data: lastIn } = await admin.from("messages").select("rfc_message_id, thread_id")
      .eq("job_id", m.job_id).eq("direction", "in").eq("channel", "email")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    const sent = await g.sendEmail({
      to, subject: m.subject ?? "Green Timber Trees", body,
      threadId: m.thread_id ?? lastIn?.thread_id, inReplyTo: lastIn?.rfc_message_id,
    });
    await admin.from("messages").update({
      body, to_addr: to, status: "sent", sent_at: new Date().toISOString(),
      external_id: sent.id, thread_id: sent.threadId,
    }).eq("id", messageId);
    return { sent: true };
  }

  // WhatsApp / SMS: not connected to a sending service yet, so open the phone's app with the text ready.
  const phone = m.to_addr || customer?.whatsapp || customer?.phone;
  if (!phone) throw new HttpError(400, "No phone number for this customer yet");
  const link = m.channel === "whatsapp"
    ? `https://wa.me/${ukToInternational(phone)}?text=${encodeURIComponent(body)}`
    : `sms:${phone.replace(/\s+/g, "")}?body=${encodeURIComponent(body)}`;
  await admin.from("messages").update({ body, to_addr: phone, status: "sent", sent_at: new Date().toISOString() }).eq("id", messageId);
  return { sent: false, openLink: link };
}

// ---------------- Site visits ----------------

export async function cancelVisit(visitId: string) {
  const { data: v } = await admin.from("site_visits").select("*").eq("id", visitId).single();
  if (!v) return;
  if (v.calendar_event_id) await g.deleteEvent(v.calendar_event_id);
  if (v.call_event_id) await g.deleteEvent(v.call_event_id);
  await admin.from("messages").delete().eq("job_id", v.job_id).eq("kind", "visit_reminder").eq("status", "scheduled");
  await admin.from("site_visits").update({ status: "cancelled" }).eq("id", visitId);
}

export async function bookVisit(jobId: string, startIso: string) {
  const settings = await getSettings();
  const job = await loadJob(jobId);
  const c = job.customers ?? {};
  const start = new Date(startIso);
  const end = new Date(start.getTime() + settings.visit_minutes * 60000);
  const name = c.name ?? "Customer";

  const { data: existing } = await admin.from("site_visits").select("id").eq("job_id", jobId).neq("status", "cancelled");
  for (const v of existing ?? []) await cancelVisit(v.id);

  let eventId: string | null = null;
  let callEventId: string | null = null;
  const visitDate = londonDate(start);
  let callDate = addDays(visitDate, -settings.call_reminder_days);
  if (callDate < londonDate(new Date())) callDate = londonDate(new Date());
  const callAt = londonToUtc(callDate, "09:00");

  if (await g.isConnected()) {
    const details = [
      job.summary, `Phone: ${c.phone ?? "not given"}`, `Email: ${c.email ?? "not given"}`,
      `Access: ${job.access_notes ?? "unknown"}`, `Waste: ${job.waste_notes ?? "unknown"}`,
    ].filter(Boolean).join("\n");
    const ev = await g.createEvent({
      summary: `Site visit – ${name}${job.postcode ? ` (${job.postcode})` : ""}`,
      location: [job.site_address, job.postcode].filter(Boolean).join(", "),
      description: details,
      start: { dateTime: start.toISOString(), timeZone: "Europe/London" },
      end: { dateTime: end.toISOString(), timeZone: "Europe/London" },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
    });
    eventId = ev.id;
    if (callAt.getTime() < start.getTime()) {
      const callEv = await g.createEvent({
        summary: `Call ${name} to confirm site visit ${formatSlot(start)}`,
        description: `Phone: ${c.phone ?? "not given"}\n${job.site_address ?? ""} ${job.postcode ?? ""}`,
        start: { dateTime: callAt.toISOString(), timeZone: "Europe/London" },
        end: { dateTime: new Date(callAt.getTime() + 15 * 60000).toISOString(), timeZone: "Europe/London" },
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
      });
      callEventId = callEv.id;
    }
  }

  // Reminder email to the customer, sent automatically by the timer job.
  let remindAt = londonToUtc(addDays(visitDate, -settings.customer_reminder_days), "18:00");
  if (remindAt.getTime() < Date.now()) {
    remindAt = start.getTime() - Date.now() > 18 * 3600_000 ? new Date(Date.now() + 10 * 60000) : new Date(0);
  }
  if (remindAt.getTime() > 0) {
    await admin.from("messages").insert({
      job_id: jobId, channel: "email", direction: "out", status: "scheduled", kind: "visit_reminder",
      subject: `Reminder: site visit ${formatSlot(start)}`,
      body: `Hi ${firstName(c.name)},\n\nJust a reminder that we'll be visiting ${[job.site_address, job.postcode].filter(Boolean).join(", ") || "you"} on ${formatLongDate(start)} at ${formatSlot(start).split(", ")[1]} to look at the trees and talk through what you'd like done.\n\nIf the time no longer suits, just reply to this email and we'll rearrange.\n\n${settings.signature}`,
      send_at: remindAt.toISOString(),
    });
  }

  const { data: visit } = await admin.from("site_visits").insert({
    job_id: jobId, starts_at: start.toISOString(), ends_at: end.toISOString(), status: "confirmed",
    calendar_event_id: eventId, call_event_id: callEventId,
    call_reminder_at: callAt.toISOString(), customer_reminder_at: remindAt.getTime() > 0 ? remindAt.toISOString() : null,
  }).select("*").single();
  await admin.from("jobs").update({ step: Math.max(job.step, 2), offered_slots: [] }).eq("id", jobId);
  return visit;
}

// ---------------- Quotes, jobs and invoices ----------------

async function totals(jobId: string) {
  const settings = await getSettings();
  const { data: items } = await admin.from("job_items").select("*").eq("job_id", jobId).order("sort");
  const subtotal = (items ?? []).reduce((s: number, i: any) => s + Number(i.quantity) * Number(i.unit_cost), 0);
  const vat = Math.round(subtotal * Number(settings.vat_rate)) / 100;
  return { items: items ?? [], subtotal, vat, total: subtotal + vat, settings };
}

function itemLines(items: any[]): string {
  const groups: Record<string, string> = {
    labour: "Labour", equipment: "Equipment hire", material: "Materials", permission: "Permissions", other: "Other",
  };
  const out: string[] = [];
  for (const k of Object.keys(groups)) {
    const rows = items.filter((i) => i.kind === k);
    if (!rows.length) continue;
    out.push(groups[k]);
    for (const r of rows) {
      const qty = Number(r.quantity);
      out.push(`  ${r.description}${qty !== 1 ? ` × ${qty}${r.unit ? ` ${r.unit}` : ""}` : ""}: ${money(qty * Number(r.unit_cost))}`);
    }
  }
  return out.join("\n");
}

async function emailCustomer(jobId: string, kind: string, subject: string, body: string) {
  const job = await loadJob(jobId);
  const to = job.customers?.email;
  const { data: msg } = await admin.from("messages").insert({
    job_id: jobId, channel: "email", direction: "out", status: "draft", kind, to_addr: to, subject, body,
  }).select("id").single();
  if (to && (await g.isConnected())) {
    await sendMessage(msg!.id);
    return { sent: true, messageId: msg!.id };
  }
  return { sent: false, messageId: msg!.id, reason: to ? "Google is not connected" : "No email address on file" };
}

export async function sendQuote(jobId: string) {
  const job = await loadJob(jobId);
  const t = await totals(jobId);
  if (!t.items.length) throw new HttpError(400, "Add some costing lines first");
  const { count } = await admin.from("quotes").select("id", { count: "exact", head: true }).eq("job_id", jobId);
  const validUntil = addDays(londonDate(new Date()), t.settings.quote_valid_days);
  const { data: quote } = await admin.from("quotes").insert({
    job_id: jobId, version: (count ?? 0) + 1, status: "sent",
    subtotal: t.subtotal, vat: t.vat, total: t.total, valid_until: validUntil, sent_at: new Date().toISOString(),
  }).select("*").single();
  const { data: flora } = await admin.from("flora").select("*").eq("job_id", jobId).order("sort");
  const work = (flora ?? []).map((f: any) => `- ${[f.label, f.species].filter(Boolean).join(" ")}: ${f.work_spec ?? ""}`).join("\n");
  const body = `Hi ${firstName(job.customers?.name)},\n\nThank you for showing us round. Here is our quote for ${job.title ?? "the tree work"} at ${[job.site_address, job.postcode].filter(Boolean).join(", ")}.\n\nWork\n${work || "- As discussed on site"}\n\n${itemLines(t.items)}\n\nSubtotal: ${money(t.subtotal)}\nVAT (${t.settings.vat_rate}%): ${money(t.vat)}\nTotal: ${money(t.total)}\n\nAccess: ${job.access_notes ?? "as discussed"}\nWaste: ${job.waste_notes ?? "as discussed"}\n${job.conservation_area === "yes" || ["required", "applied"].includes(job.tpo_status) ? "\nThis work needs council permission first. We'll handle the application and can only start once it's allowed.\n" : ""}\nThis quote is valid until ${formatLongDate(new Date(validUntil + "T12:00:00Z"))}. To go ahead, just reply to this email and we'll book a date.\n\n${t.settings.signature}`;
  const result = await emailCustomer(jobId, "quote", `Your quote – ${t.settings.business_name}`, body);
  await admin.from("jobs").update({ step: Math.max(job.step, 4) }).eq("id", jobId);
  return { quote, ...result };
}

export async function bookJob(jobId: string, startDate: string, endDate: string) {
  const settings = await getSettings();
  const job = await loadJob(jobId);
  const c = job.customers ?? {};
  if (job.earliest_start && startDate < job.earliest_start) {
    throw new HttpError(400, `Council permission means work can't start before ${job.earliest_start}`);
  }
  if (job.job_calendar_event_id) await g.deleteEvent(job.job_calendar_event_id);
  await admin.from("messages").delete().eq("job_id", jobId).eq("kind", "job_reminder").eq("status", "scheduled");

  let eventId: string | null = null;
  if (await g.isConnected()) {
    const { items } = await totals(jobId);
    const ev = await g.createEvent({
      summary: `Job – ${c.name ?? "Customer"}${job.postcode ? ` (${job.postcode})` : ""}`,
      location: [job.site_address, job.postcode].filter(Boolean).join(", "),
      description: [
        job.title, `Phone: ${c.phone ?? "-"}`, `Crew: ${job.crew_size ?? "-"}`,
        `Access: ${job.access_notes ?? "-"}`, `Waste: ${job.waste_notes ?? "-"}`,
        items.filter((i: any) => i.kind === "equipment").length
          ? `Equipment: ${items.filter((i: any) => i.kind === "equipment").map((i: any) => i.description).join(", ")}` : "",
      ].filter(Boolean).join("\n"),
      start: { date: startDate },
      end: { date: addDays(endDate, 1) },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 12 * 60 }] },
    });
    eventId = ev.id;
  }

  const startD = new Date(startDate + "T12:00:00Z");
  const dates = startDate === endDate ? formatLongDate(startD) : `${formatLongDate(startD)} to ${formatLongDate(new Date(endDate + "T12:00:00Z"))}`;
  await emailCustomer(jobId, "job_confirmation", `Booked: tree work on ${formatLongDate(startD)}`,
    `Hi ${firstName(c.name)},\n\nThank you for accepting our quote. We've booked your work for ${dates}. We'll arrive at around 8am.\n\nPlease make sure we can get to the work area (${job.access_notes ?? "as discussed"}). If anything changes, just reply to this email.\n\n${settings.signature}`);

  const remindAt = londonToUtc(addDays(startDate, -2), "18:00");
  if (remindAt.getTime() > Date.now()) {
    await admin.from("messages").insert({
      job_id: jobId, channel: "email", direction: "out", status: "scheduled", kind: "job_reminder",
      subject: `Reminder: tree work on ${formatLongDate(startD)}`,
      body: `Hi ${firstName(c.name)},\n\nJust a reminder that we'll be with you on ${dates}, arriving around 8am. Please make sure we can get to the work area, and move any cars that might be in the way.\n\n${settings.signature}`,
      send_at: remindAt.toISOString(),
    });
  }
  await admin.from("jobs").update({
    step: 5, status: "won", job_start: startDate, job_end: endDate, job_calendar_event_id: eventId,
  }).eq("id", jobId);
  return { booked: true };
}

export async function createInvoice(jobId: string, send: boolean) {
  const job = await loadJob(jobId);
  const t = await totals(jobId);
  if (!t.items.length) throw new HttpError(400, "Add costing lines first");
  const { count } = await admin.from("invoices").select("id", { count: "exact", head: true });
  const number = `GT-${String(1001 + (count ?? 0))}`;
  const issued = londonDate(new Date());
  const due = addDays(issued, t.settings.invoice_due_days);
  const { data: inv } = await admin.from("invoices").insert({
    job_id: jobId, number, status: send ? "sent" : "draft",
    subtotal: t.subtotal, vat: t.vat, total: t.total, issued_on: issued, due_on: due,
  }).select("*").single();
  let result: Record<string, unknown> = {};
  if (send) {
    result = await emailCustomer(jobId, "invoice", `Invoice ${number} – ${t.settings.business_name}`,
      `Hi ${firstName(job.customers?.name)},\n\nThank you for choosing us. Here is your invoice for the work at ${[job.site_address, job.postcode].filter(Boolean).join(", ")}.\n\nInvoice ${number}\nDate: ${formatLongDate(new Date())}\n\n${itemLines(t.items)}\n\nSubtotal: ${money(t.subtotal)}\nVAT (${t.settings.vat_rate}%): ${money(t.vat)}\nTotal due: ${money(t.total)}\nDue by: ${formatLongDate(new Date(due + "T12:00:00Z"))}\n\n${t.settings.invoice_footer}\n\n${t.settings.signature}`);
  }
  await admin.from("jobs").update({ status: "completed" }).eq("id", jobId);
  return { invoice: inv, ...result };
}

// ---------------- Gmail sync and scheduled sending ----------------

async function savePhoto(jobId: string, bytes: Uint8Array, filename: string, mimeType: string, source: string) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
  const path = `${jobId}/${crypto.randomUUID()}-${safe}`;
  const { error } = await admin.storage.from("job-photos").upload(path, bytes, { contentType: mimeType });
  if (error) { console.warn("photo upload failed", error.message); return; }
  await admin.from("photos").insert({ job_id: jobId, storage_path: path, source });
}

export async function syncGmail() {
  const conn = await g.getConnection();
  if (!conn?.refresh_token) return { skipped: "Google not connected" };
  const days = conn.last_synced_at ? 2 : 3;
  const ids = await g.listMessageIds(`in:inbox -from:me newer_than:${days}d -category:promotions -category:social -category:forums`, 30);
  const { data: done } = await admin.from("processed_gmail").select("gmail_id").in("gmail_id", ids.map((i) => i.id));
  const doneSet = new Set((done ?? []).map((d: any) => d.gmail_id));
  const todo = ids.filter((i) => !doneSet.has(i.id)).reverse().slice(0, 8);
  let created = 0, updated = 0, ignored = 0;

  for (const ref of todo) {
    try {
      const e = await g.getEmail(ref.id);
      if (conn.google_email && e.fromEmail === conn.google_email.toLowerCase()) {
        await admin.from("processed_gmail").insert({ gmail_id: ref.id, is_enquiry: false });
        continue;
      }

      // Which job does this belong to? Same Gmail thread first, then same customer email.
      let jobId: string | null = null;
      const { data: threadMsg } = await admin.from("messages").select("job_id").eq("thread_id", e.threadId)
        .not("job_id", "is", null).limit(1).maybeSingle();
      if (threadMsg) jobId = threadMsg.job_id;
      if (!jobId) {
        const { data: cust } = await admin.from("customers").select("id, jobs(id, status, created_at)")
          .ilike("email", e.fromEmail).limit(1).maybeSingle();
        const open = (cust?.jobs ?? []).filter((j: any) => j.status === "open")
          .sort((a: any, b: any) => b.created_at.localeCompare(a.created_at))[0];
        if (open) jobId = open.id;
      }

      let isNew = false;
      let customerId: string | null = null;
      if (!jobId) {
        isNew = true;
        const { data: existingCust } = await admin.from("customers").select("id").ilike("email", e.fromEmail).limit(1).maybeSingle();
        customerId = existingCust?.id ?? null;
        if (!customerId) {
          const { data: cust } = await admin.from("customers")
            .insert({ email: e.fromEmail, name: e.fromName || null }).select("id").single();
          customerId = cust!.id;
        }
        const { data: job } = await admin.from("jobs").insert({ customer_id: customerId, source: "email", step: 1 }).select("id").single();
        jobId = job!.id;
      }

      await admin.from("messages").insert({
        job_id: jobId, channel: "email", direction: "in", status: "received", kind: "reply",
        from_addr: e.fromEmail, to_addr: e.to, subject: e.subject, body: e.body,
        external_id: e.id, thread_id: e.threadId, rfc_message_id: e.messageIdHeader || null,
        received_at: e.date.toISOString(),
      });
      for (const a of e.attachments.filter((a) => a.mimeType.startsWith("image/")).slice(0, 10)) {
        const bytes = await g.getAttachment(e.id, a.attachmentId);
        await savePhoto(jobId!, bytes, a.filename, a.mimeType, "email");
      }

      const result = await analyseJob(jobId!, { allowAutoSend: true });
      if (!result.isEnquiry && isNew) {
        const { data: photos } = await admin.from("photos").select("storage_path").eq("job_id", jobId);
        if (photos?.length) await admin.storage.from("job-photos").remove(photos.map((p: any) => p.storage_path));
        await admin.from("jobs").delete().eq("id", jobId);
        const { count } = await admin.from("jobs").select("id", { count: "exact", head: true }).eq("customer_id", customerId);
        if (!count) await admin.from("customers").delete().eq("id", customerId);
        ignored++;
      } else if (isNew) created++;
      else updated++;
      await admin.from("processed_gmail").insert({ gmail_id: ref.id, is_enquiry: result.isEnquiry });
    } catch (err) {
      console.error("sync message failed", ref.id, err);
    }
  }
  await admin.from("google_connections").update({ last_synced_at: new Date().toISOString() }).eq("id", 1);
  return { created, updated, ignored, checked: todo.length };
}

export async function sendDueMessages() {
  if (!(await g.isConnected())) return { sent: 0 };
  const { data: due } = await admin.from("messages").select("id, job_id, jobs(customers(email))")
    .eq("status", "scheduled").lte("send_at", new Date().toISOString()).limit(20);
  let sent = 0;
  for (const m of due ?? []) {
    const email = (m as any).jobs?.customers?.email;
    if (!email) continue; // waits until we have an email address
    try {
      await admin.from("messages").update({ to_addr: email }).eq("id", m.id);
      await sendMessage(m.id);
      sent++;
    } catch (err) {
      console.error("scheduled send failed", m.id, err);
      await admin.from("messages").update({ status: "failed" }).eq("id", m.id);
    }
  }
  return { sent };
}
