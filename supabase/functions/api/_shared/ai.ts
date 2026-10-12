// Calls Claude to read an enquiry conversation and draft the next reply.
import { HttpError } from "./supa.ts";

export interface Slot { id: string; start: string; label: string }

export interface Analysis {
  is_enquiry: boolean;
  title: string | null;
  summary: string | null;
  customer: { name: string | null; phone: string | null; email: string | null };
  site_address: string | null;
  postcode: string | null;
  flora: { species: string | null; size: string | null; work: string | null }[];
  access_notes: string | null;
  waste_notes: string | null;
  urgency: "emergency" | "standard" | "flexible";
  missing: string[];
  accepted_slot_id: string | null;
  reply: string | null;
}

const SYSTEM = (business: string, signature: string) => `You handle new customer enquiries for ${business}, a tree surgery business in Brighton, Hove and Sussex (UK). You read the conversation so far and return JSON only.

Your job for each enquiry:
1. Work out who is asking: their name, phone and email.
2. Find where the work is: full site address and UK postcode.
3. Note which trees, hedges or plants need work and what they want done.
4. Collect what is still missing, in this order of importance: site postcode/address; photos of the trees (ask for them if none have been received); access to the work area (side gate width, through the house, parking); whether rubbish, cuttings and logs should be removed or left; an email address if the conversation is on WhatsApp or SMS; a phone number if it is by email.
5. Close the exchange quickly by agreeing a free site visit. Offer the visit slots provided (use their labels exactly) and ask which suits. If the customer has clearly accepted one of the offered slots, set accepted_slot_id to that slot's id and write a reply confirming the date and time, saying a reminder will follow a couple of days before.

Rules for the reply:
- British English, friendly and short (under 120 words), plain text, no markdown.
- Ask for at most the four most important missing items, in one short list or sentence.
- Never quote prices or promise dates other than the offered slots. Never invent facts.
- If it is an emergency (tree or branch down, danger to people or property), say Adam will call as soon as possible and ask for a phone number if missing.
- Sign off as: ${signature}
- If nothing needs saying (for example the customer only said thanks after a confirmation), set reply to null.

Set is_enquiry to false for anything that is not a customer asking about tree, hedge, stump or garden work (newsletters, suppliers, invoices, spam, notifications). For those, other fields can be null.

missing must use only these words: "name", "phone", "email", "address", "postcode", "photos", "access", "waste".

Return exactly this JSON shape and nothing else:
{"is_enquiry":true,"title":"short job title","summary":"one sentence","customer":{"name":null,"phone":null,"email":null},"site_address":null,"postcode":null,"flora":[{"species":null,"size":null,"work":null}],"access_notes":null,"waste_notes":null,"urgency":"standard","missing":[],"accepted_slot_id":null,"reply":"..."}`;

export async function analyseConversation(input: {
  business: string;
  signature: string;
  channel: string;
  known: Record<string, unknown>;
  photosReceived: number;
  slots: Slot[];
  conversation: { direction: string; when: string; text: string }[];
  today: string;
}): Promise<Analysis> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new HttpError(500, "The AI key has not been added yet");
  const model = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5-5";

  const user = [
    `Today is ${input.today}. Channel: ${input.channel}.`,
    `Details already on file (may be blank): ${JSON.stringify(input.known)}`,
    `Photos received so far: ${input.photosReceived}`,
    input.slots.length
      ? `Visit slots you may offer: ${input.slots.map((s) => `${s.id} = ${s.label}`).join("; ")}`
      : "No visit slots are available to offer right now; say Adam will be in touch with times.",
    "Conversation, oldest first:",
    ...input.conversation.map((m) => `--- ${m.direction === "in" ? "CUSTOMER" : "US"} (${m.when}) ---\n${m.text}`),
  ].join("\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system: SYSTEM(input.business, input.signature),
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`AI request failed: ${data?.error?.message ?? res.status}`);
  const text: string = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("AI did not return JSON");
  const parsed = JSON.parse(text.slice(start, end + 1));
  return {
    is_enquiry: !!parsed.is_enquiry,
    title: parsed.title ?? null,
    summary: parsed.summary ?? null,
    customer: parsed.customer ?? { name: null, phone: null, email: null },
    site_address: parsed.site_address ?? null,
    postcode: parsed.postcode ?? null,
    flora: Array.isArray(parsed.flora) ? parsed.flora.filter((f: any) => f && (f.species || f.work)) : [],
    access_notes: parsed.access_notes ?? null,
    waste_notes: parsed.waste_notes ?? null,
    urgency: ["emergency", "standard", "flexible"].includes(parsed.urgency) ? parsed.urgency : "standard",
    missing: Array.isArray(parsed.missing) ? parsed.missing : [],
    accepted_slot_id: parsed.accepted_slot_id ?? null,
    reply: parsed.reply ?? null,
  };
}
