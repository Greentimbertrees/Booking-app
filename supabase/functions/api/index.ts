// Single server endpoint for the Green Timber Jobs app.
//   GET  /api/google/callback      Google sign-in returns here
//   POST /api/  {action:"cron"}    timer job (needs x-cron-secret)
//   POST /api/  {action:...}       app actions (needs a signed-in app user)
import { admin, corsHeaders, getConfig, handleError, HttpError, json, requireAppUser } from "./_shared/supa.ts";
import * as g from "./_shared/google.ts";
import { callback, makeState } from "./_shared/googleAuth.ts";
import * as wf from "./_shared/workflow.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  try {
    if (url.pathname.endsWith("/google/callback")) return await callback(url);

    const b = await req.json().catch(() => ({}));

    if (b.action === "cron") {
      const secret = await getConfig("cron_secret");
      if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "Forbidden" }, 403);
      const due = await wf.sendDueMessages();
      const sync = await wf.syncGmail();
      return json({ ...sync, ...due });
    }

    await requireAppUser(req);
    const need = (k: string) => {
      if (!b[k]) throw new HttpError(400, `${k} missing`);
      return b[k];
    };

    switch (b.action) {
      // ---- Google account ----
      case "google-start":
        return json({ url: g.authUrl(await makeState(need("returnTo"))) });

      case "google-status": {
        const c = await g.getConnection();
        return json({
          configured: !!Deno.env.get("GOOGLE_CLIENT_ID") && !!Deno.env.get("GOOGLE_CLIENT_SECRET"),
          aiConfigured: !!Deno.env.get("ANTHROPIC_API_KEY"),
          connected: !!c?.refresh_token,
          google_email: c?.google_email ?? null,
          calendar_id: c?.calendar_id ?? null,
          calendar_name: c?.calendar_name ?? null,
          last_synced_at: c?.last_synced_at ?? null,
          redirect_uri: g.redirectUri(),
        });
      }

      case "google-calendars":
        return json({ calendars: await g.listCalendars() });

      case "google-set-calendar":
        await admin.from("google_connections").update({ calendar_id: need("id"), calendar_name: b.name ?? b.id }).eq("id", 1);
        return json({ ok: true });

      case "google-disconnect": {
        const c = await g.getConnection();
        if (c?.refresh_token) await g.revokeToken(c.refresh_token);
        await admin.from("google_connections").update({ refresh_token: null, access_token: null, access_expires_at: null }).eq("id", 1);
        return json({ ok: true });
      }

      // ---- Messages and enquiries ----
      case "sync": {
        const sync = await wf.syncGmail();
        const due = await wf.sendDueMessages();
        return json({ ...sync, ...due });
      }

      case "new-enquiry": {
        // A message pasted in from WhatsApp, SMS or a phone call.
        const text: string = need("text");
        const channel: string = ["whatsapp", "sms", "phone", "email", "web", "other"].includes(b.channel) ? b.channel : "other";
        const { data: cust, error: ce } = await admin.from("customers").insert({
          name: b.name || null,
          phone: b.phone || null,
          email: b.email ? String(b.email).toLowerCase() : null,
          whatsapp: channel === "whatsapp" ? (b.phone || null) : null,
        }).select("id").single();
        if (ce) throw ce;
        const { data: job, error: je } = await admin.from("jobs").insert({ customer_id: cust!.id, source: channel, step: 1 }).select("id").single();
        if (je) throw je;
        await admin.from("messages").insert({
          job_id: job!.id,
          channel: channel === "whatsapp" || channel === "sms" ? channel : "email",
          direction: "in", status: "received", body: text,
          from_addr: b.phone || b.email || null, received_at: new Date().toISOString(),
        });
        let analysis: unknown = null;
        try {
          analysis = await wf.analyseJob(job!.id);
        } catch (e) {
          analysis = { error: e instanceof Error ? e.message : String(e) };
        }
        return json({ jobId: job!.id, analysis });
      }

      case "add-incoming": {
        // A further WhatsApp/SMS reply pasted into an existing job.
        const jobId = need("jobId");
        const { data: job } = await admin.from("jobs").select("source").eq("id", jobId).single();
        const ch = job?.source === "whatsapp" || job?.source === "sms" ? job.source : "email";
        await admin.from("messages").insert({
          job_id: jobId, channel: ch, direction: "in", status: "received", body: need("text"),
          received_at: new Date().toISOString(),
        });
        return json(await wf.analyseJob(jobId));
      }

      case "analyse":
        return json(await wf.analyseJob(need("jobId")));

      case "send-message":
        return json(await wf.sendMessage(need("messageId"), b.body));

      // ---- Visits, quotes, jobs, invoices ----
      case "slots":
        return json({ slots: await wf.findSlots(b.postcode ?? null, b.count ?? 3) });

      case "book-visit":
        return json({ visit: await wf.bookVisit(need("jobId"), need("startsAt")) });

      case "cancel-visit":
        await wf.cancelVisit(need("visitId"));
        return json({ ok: true });

      case "send-quote":
        return json(await wf.sendQuote(need("jobId")));

      case "book-job":
        return json(await wf.bookJob(need("jobId"), need("startDate"), b.endDate || b.startDate));

      case "create-invoice":
        return json(await wf.createInvoice(need("jobId"), !!b.send));

      default:
        throw new HttpError(400, "Unknown action");
    }
  } catch (e) {
    return handleError(e);
  }
});
