# Green Timber Jobs

Phone app (PWA) for Green Timber Trees: enquiries from Gmail, WhatsApp and SMS, site visits, job specification, quotes, job booking and invoices.

The jobs move through five steps, shown as tabs in the app:

| Tab | Step | What happens |
| --- | --- | --- |
| Enq | 1. Enquiry | Gmail is read every 5 minutes. The AI picks out name, site address and postcode, trees, access and waste, asks for photos and any missing phone/email, and offers free visit times. |
| Visit | 2. Site visit | Visit goes in Google Calendar with a "call the customer" reminder (default 3 days before) and a reminder email to the customer (default 2 days before). Photos from the camera or gallery are saved to the job. |
| Spec | 3. Specification | Trees and plants, work needed, TPO and conservation-area status, nesting check, equipment and materials, crew size and days. |
| Quote | 4. Quote and questions | Day rate from the area rate card, equipment hire, materials, VAT. Emailed to the customer. |
| Book | 5. Schedule job | Job dates in Google Calendar (respecting the council notice period), confirmation and reminder emails, invoice. |

## How it fits together

- `web/` – the app. React, bundled with esbuild into `web/dist`, which Netlify serves as-is.
- `supabase/functions/api/` – one Supabase Edge Function that does everything needing Gmail, Google Calendar or the AI.
- `supabase/migrations/` – the database tables, photo storage and the 5-minute timer job.
- `netlify.toml` – tells Netlify to publish `web/dist`.

Live services: Supabase project `greentimber-jobs` (London) and Netlify site `greentimber-jobs`.

## Settings that live outside the code

Supabase → Edge Functions → Secrets:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` – Google Cloud OAuth client (Web application) with the Gmail API and Google Calendar API turned on. Authorised redirect URI: `https://ltfbynpckvmqkjbofssr.supabase.co/functions/v1/api/google/callback`
- `ANTHROPIC_API_KEY` – for drafting replies. Optional `CLAUDE_MODEL`.

Supabase → Authentication → URL Configuration: Site URL and Redirect URL = the Netlify address.

People allowed to use the app are listed in the `app_users` table.

The Google account (Gmail and calendar) is connected, switched or disconnected from Settings in the app.

## Changing the app

```bash
cd web
npm install
npm run build      # writes web/dist
```

Commit `web/dist` and Netlify publishes it. Server changes: deploy `supabase/functions/api` with `supabase functions deploy api --no-verify-jwt`.

## Not automated yet

WhatsApp and SMS replies open in the phone's own app ready to send. Sending them automatically needs a WhatsApp Business API account (Meta) and an SMS provider such as Twilio.
