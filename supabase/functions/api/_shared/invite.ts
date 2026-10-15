// Calendar invites for customers (site visits and booked jobs) and the email footer
// (logo and mobile number under the signature).

/** Stored on messages.calendar so the invite goes out whenever that email is sent. */
export interface CalendarInvite {
  uid: string;          // stable per visit/job so a re-send updates the same entry
  title: string;
  location?: string;
  description?: string;
  start: string;        // ISO instant, or YYYY-MM-DD for all-day
  end: string;          // ISO instant, or YYYY-MM-DD (exclusive) for all-day
  allDay?: boolean;
  sequence?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const utcStamp = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const dateStamp = (ymd: string) => ymd.replaceAll("-", "");

function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Lines over 75 octets are folded, as the iCalendar format requires. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const ch of line) {
    const len = new TextEncoder().encode(ch).length;
    if (curLen + len > (out.length ? 74 : 75)) { out.push(cur); cur = ""; curLen = 0; }
    cur += ch; curLen += len;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** An .ics file (iCal) that Apple Calendar, Outlook and Google Calendar can all open. */
export function buildIcs(inv: CalendarInvite, organiser: { name: string; email?: string | null }): string {
  const when = inv.allDay
    ? [`DTSTART;VALUE=DATE:${dateStamp(inv.start)}`, `DTEND;VALUE=DATE:${dateStamp(inv.end)}`]
    : [`DTSTART:${utcStamp(new Date(inv.start))}`, `DTEND:${utcStamp(new Date(inv.end))}`];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Green Timber Trees//Jobs//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${inv.uid}`,
    `SEQUENCE:${inv.sequence ?? 0}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    ...when,
    `SUMMARY:${icsText(inv.title)}`,
    inv.location ? `LOCATION:${icsText(inv.location)}` : "",
    inv.description ? `DESCRIPTION:${icsText(inv.description)}` : "",
    organiser.email ? `ORGANIZER;CN=${icsText(organiser.name)}:mailto:${organiser.email}` : "",
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    inv.allDay ? "" : "BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT1H\r\nEND:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return lines.flatMap((l) => l.split("\r\n")).map(fold).join("\r\n") + "\r\n";
}

/** "Add to Google Calendar" link that opens a pre-filled event for the customer. */
export function googleCalendarLink(inv: CalendarInvite): string {
  const dates = inv.allDay
    ? `${dateStamp(inv.start)}/${dateStamp(inv.end)}`
    : `${utcStamp(new Date(inv.start))}/${utcStamp(new Date(inv.end))}`;
  const p = new URLSearchParams({ action: "TEMPLATE", text: inv.title, dates });
  if (inv.location) p.set("location", inv.location);
  if (inv.description) p.set("details", inv.description);
  if (!inv.allDay) p.set("ctz", "Europe/London");
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

// ---------------- Email body and footer ----------------

export interface Branding {
  mobile?: string | null;
  logoUrl?: string | null;
  businessName: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function telHref(mobile: string): string {
  const d = mobile.replace(/[^\d+]/g, "");
  return d.startsWith("0") ? `+44${d.slice(1)}` : d;
}

/** Plain-text version: body, mobile under the signature, then the calendar links. */
export function plainBody(body: string, brand: Branding, invite?: CalendarInvite | null): string {
  let out = body.trimEnd();
  if (brand.mobile) out += `\nMobile: ${brand.mobile}`;
  if (invite) {
    out += `\n\n---\nAdd this to your calendar\nGoogle Calendar: ${googleCalendarLink(invite)}\nApple Calendar / Outlook (iCal): open the attached invite.ics`;
  }
  return out + "\n";
}

/** HTML version: same text, calendar buttons, and the logo and mobile under the signature. */
export function htmlBody(body: string, brand: Branding, invite?: CalendarInvite | null): string {
  const text = esc(body.trimEnd())
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\r?\n/g, "<br>");
  const cal = invite ? `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;border-collapse:collapse">
  <tr><td colspan="2" style="font:600 14px Arial,sans-serif;color:#1f3a2a;padding-bottom:8px">Add this to your calendar</td></tr>
  <tr>
    <td style="padding:0 8px 0 0"><a href="${esc(googleCalendarLink(invite))}" style="display:inline-block;background:#2f6b43;color:#ffffff;text-decoration:none;font:600 14px Arial,sans-serif;padding:10px 16px;border-radius:6px">Google Calendar</a></td>
    <td style="font:13px Arial,sans-serif;color:#555">Apple Calendar or Outlook: open the attached <strong>invite.ics</strong></td>
  </tr>
</table>` : "";
  const logo = brand.logoUrl
    ? `<div style="margin-top:12px"><img src="${esc(brand.logoUrl)}" alt="${esc(brand.businessName)}" width="200" style="display:block;width:200px;max-width:200px;height:auto;border:0"></div>`
    : "";
  const mobile = brand.mobile
    ? `<div style="margin-top:8px;font:14px Arial,sans-serif;color:#222">Mobile: <a href="tel:${esc(telHref(brand.mobile))}" style="color:#2f6b43;text-decoration:none">${esc(brand.mobile)}</a></div>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:0">
<div style="font:14px/1.5 Arial,sans-serif;color:#222;max-width:640px">
<div>${text}</div>${logo}${mobile}${cal}
</div></body></html>`;
}
