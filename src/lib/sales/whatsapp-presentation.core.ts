/**
 * UMRAIO® — WhatsApp sales presentation + decision-routing layer.
 *
 * PURE functions only (no I/O). This module shapes HOW the sales AI presents
 * an answer and WHEN it must answer directly instead of asking another
 * clarifying question. It never changes quotation business rules, tenant
 * scoping, transport, ASR/voice or any tool behaviour.
 */

export const WHATSAPP_FORMAT_INSTRUCTION = [
  "WHATSAPP REPLY FORMAT (mandatory for every customer-facing text reply):",
  "- Write short paragraphs. Maximum 2-4 short paragraphs before your single next question or action.",
  "- Never send a wall of text. Break lines instead.",
  "- Use WhatsApp bold (single asterisks) for important labels and figures, e.g. *Harga*, *Jumlah*, *Pakej*, *Tempoh*, *Hotel*. Never use markdown headings (#) or double asterisks.",
  "- Use a short bolded title line when you present a quotation, a price breakdown or a package summary.",
  "- Use bullet lines starting with • for lists of two or more facts.",
  "- Keep every line scannable on a phone screen.",
].join("\n");

export const QUOTATION_AUTONOMY_INSTRUCTION = [
  "QUOTATION AUTONOMY: when the package and pilgrim count are known (from this conversation or the lead profile), you must EXECUTE create_quotation yourself. Do not say 'saya akan maklumkan staff' for something you can do.",
  "If create_quotation succeeds: present a concise summary (*Pakej*, *Harga*, *Jumlah*, *Tempoh*), the quotation reference and the customer link returned by the tool, then one clear next action.",
  "If create_quotation is REJECTED because a live quotation already exists: explain that existing quotation plainly, include its reference and amount when you have them, and offer the next action (semak semula, tukar pakej, atau teruskan deposit). Never claim a new quotation was created.",
  "Never state a quotation exists, was created, sent or updated unless a tool in THIS conversation returned it.",
].join("\n");

export const HANDOVER_LANGUAGE_INSTRUCTION = [
  "HANDOVER LANGUAGE: 'staff' is not a default answer. Mention a human colleague ONLY when a human approval/action is genuinely required, the system truly lacks the capability, or a business rule demands it.",
  "Never say a staff member has been notified, is checking, or has sent anything unless a tool call in this conversation confirmed it.",
].join("\n");

export const NEXT_BEST_ACTION_INSTRUCTION = [
  "NEXT BEST ACTION: after answering a simple question (price, duration, hotel), end with exactly ONE clear next action or question — never a list of questions.",
].join("\n");

/* ------------------------------------------------------------------ */
/* B — direct answer to price intent                                    */
/* ------------------------------------------------------------------ */

const PRICE_INTENT_PATTERNS: RegExp[] = [
  /\bharga\b/i,
  /\bberapa\b/i,
  /\bprice\b/i,
  /\bcost\b/i,
  /\bhow\s+much\b/i,
  /\btotal\b/i,
  /\bjumlah\b/i,
];

export function detectPriceIntent(text: string | null | undefined): boolean {
  if (!text) return false;
  return PRICE_INTENT_PATTERNS.some((re) => re.test(text));
}

export type PricingPackage = {
  name: string;
  price_myr: number | null;
  nights?: number | null;
};

export function directPriceInstruction(input: {
  latestMessage?: string | null;
  packages: PricingPackage[];
  pax?: number | null;
  packageInterest?: string | null;
}): string | null {
  if (!detectPriceIntent(input.latestMessage)) return null;

  const priced = input.packages.filter(
    (p) => typeof p.price_myr === "number" && Number.isFinite(p.price_myr) && (p.price_myr ?? 0) > 0,
  );

  if (!priced.length) {
    return [
      "PRICE INTENT DETECTED — but no catalogue price is available in context.",
      "Say clearly which single piece of information is missing and ask ONLY for that. Do not invent a figure and do not defer to staff.",
    ].join("\n");
  }

  const focus =
    (input.packageInterest &&
      priced.find((p) => p.name.toLowerCase().includes(input.packageInterest!.toLowerCase()))) ||
    null;
  const shown = focus ? [focus] : priced.slice(0, 3);
  const pax = input.pax && input.pax > 0 ? input.pax : null;

  const lines = shown.map((p) => {
    const per = p.price_myr as number;
    const parts = [`${p.name}: seorang RM${per.toLocaleString("en-MY")}`];
    if (pax) parts.push(`${pax} orang RM${(per * pax).toLocaleString("en-MY")}`);
    if (p.nights) parts.push(`${p.nights} malam`);
    return `- ${parts.join(" | ")}`;
  });

  return [
    "PRICE INTENT DETECTED — ANSWER DIRECTLY NOW. Do not ask another clarifying question first.",
    "Authoritative catalogue figures already in context (use these exact numbers, never recalculate or round):",
    ...lines,
    pax
      ? `Pilgrim count already known: ${pax}. Do not ask for it again.`
      : "Pilgrim count unknown: give the per-person price first, then ask ONLY for pax.",
    "Present it as: a bold title line, bullet lines with *Harga seorang*, *Jumlah* (if pax known) and *Tempoh*, then ONE next action.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* E — conversational memory                                            */
/* ------------------------------------------------------------------ */

export function knownContextInstruction(facts: {
  pax?: number | null;
  preferredMonth?: string | null;
  packageInterest?: string | null;
  city?: string | null;
  fullName?: string | null;
}): string | null {
  const known: string[] = [];
  if (facts.fullName) known.push(`nama: ${facts.fullName}`);
  if (facts.pax && facts.pax > 0) known.push(`bilangan jemaah: ${facts.pax}`);
  if (facts.preferredMonth) known.push(`bulan: ${facts.preferredMonth}`);
  if (facts.packageInterest) known.push(`pakej: ${facts.packageInterest}`);
  if (facts.city) known.push(`bandar: ${facts.city}`);
  if (!known.length) return null;
  return [
    "ALREADY KNOWN — NEVER ASK AGAIN:",
    ...known.map((k) => `- ${k}`),
    "Reuse these facts silently in your answer instead of re-qualifying the customer.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* D/F — PDF + continuation intent                                      */
/* ------------------------------------------------------------------ */

const PDF_ASK = /\b(pdf|dokumen|document|fail|file|softcopy|soft\s*copy)\b/i;

export function pdfCapabilityInstruction(latestMessage: string | null | undefined): string | null {
  if (!latestMessage || !PDF_ASK.test(latestMessage)) return null;
  return [
    "PDF REQUEST DETECTED: this system does not generate or send a PDF quotation file.",
    "If a quotation exists, share its customer link returned by create_quotation (the quotation page can be viewed and printed).",
    "If no quotation exists yet, say so plainly and offer to prepare one now.",
    "Never claim a PDF was sent and never claim staff has sent it.",
  ].join("\n");
}

const CONTINUE_INTENT =
  /\b(teruskan|proceed|lanjut|go\s*ahead|ok(ay)?\s*(la|lah)?\b.{0,10}teruskan|setuju|boleh\s+teruskan)\b/i;

export function continueIntentInstruction(latestMessage: string | null | undefined): string | null {
  if (!latestMessage || !CONTINUE_INTENT.test(latestMessage)) return null;
  return [
    "CONTINUATION INTENT DETECTED ('teruskan'/'setuju'): execute the next available action immediately using what is already known.",
    "Do not restart qualification and do not repeat questions already answered.",
  ].join("\n");
}
