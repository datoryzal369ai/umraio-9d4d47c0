/**
 * UMRAIO® STEP 3.6 — SALES INTELLIGENCE HARDENING (pure core).
 *
 * Additive deterministic layer on top of Step 3
 * (`conversation-intelligence.core.ts`) and Step 2 (`sales-intent.core.ts`).
 *
 * Nothing here calls a model, a database or the network. Every rule is
 * phrase/token-aware, auditable and unit-testable. Negative (customer-control)
 * intent is ALWAYS evaluated before positive (buying) intent.
 */

/* ------------------------------------------------------------------ *
 * FIX 6 — controlled Malaysian WhatsApp normalisation
 * ------------------------------------------------------------------ */

/** Controlled dictionary. No fuzzy matching — explicit variants only. */
const NORMALISATION_RULES: Array<[RegExp, string]> = [
  // pilgrim counts: "2org", "2 org", "org2"
  [/(\d+)\s*org\b/gi, "$1 orang"],
  [/\borg2\b/gi, "orang"],
  [/\borg\b/gi, "orang"],
  [/\bjm\b/gi, "jemaah"],
  // quantities / questions
  [/\bbrp\b/gi, "berapa"],
  [/\bbrape\b/gi, "berapa"],
  [/\bbrapa\b/gi, "berapa"],
  // deposit variants and typos
  [/\bdepost\b/gi, "deposit"],
  [/\bdiposit\b/gi, "deposit"],
  [/\bdeposite\b/gi, "deposit"],
  [/\bdp\b/gi, "deposit"],
  [/\bdep\b/gi, "deposit"],
  // booking variants
  [/\btempahan\b/gi, "booking"],
  [/\btempah\b/gi, "booking"],
  [/\breservation\b/gi, "booking"],
  [/\breserve\b/gi, "booking"],
  // months
  [/\bbulan\s*12\b/gi, "disember december"],
  [/\bdis\b/gi, "disember"],
  [/\bdec\b/gi, "december"],
  [/\bdisember\b/gi, "disember december"],
  [/\bdecember\b/gi, "disember december"],
  // common short forms
  [/\butk\b/gi, "untuk"],
  [/\bnk\b/gi, "nak"],
  [/\btk\b/gi, "tak"],
  [/\bxnak\b/gi, "tak nak"],
  [/\bmcm\b/gi, "macam"],
  [/\bdkt\b/gi, "dekat"],
  [/\bblh\b/gi, "boleh"],
  [/\bbole\b/gi, "boleh"],
  [/\bdh\b/gi, "dah"],
  [/\bsy\b/gi, "saya"],
  [/\bjgn\b/gi, "jangan"],
  [/\bskit\b/gi, "sikit"],
];

/** Normalise a customer message into a controlled matching form. */
export function normalizeMessage(text: string | null | undefined): string {
  let t = (text ?? "").toLowerCase();
  if (!t) return "";
  t = t.replace(/\u2019/g, "'");
  for (const [re, to] of NORMALISATION_RULES) t = t.replace(re, to);
  return t.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * FIX 11 — negative / positive intent collision guard
 * ------------------------------------------------------------------ */

const NEGATION_SPAN =
  /\b(tak|tidak|tak\s?nak|tak\s?mahu|jangan|bukan|belum|xnak|not|no|don'?t|dont|never|stop)\b(\s+\S+){0,3}/gi;

/**
 * Mask negated spans so positive-intent matchers can never fire inside them.
 * Used ONLY for positive detection; negative detection reads the full text.
 */
export function maskNegatedSpans(normalized: string): string {
  return normalized.replace(NEGATION_SPAN, " · ");
}

/* ------------------------------------------------------------------ *
 * FIX 1 — opt-out / do-not-contact
 * ------------------------------------------------------------------ */

/**
 * Verbs that mean "reaching out to me" in Malay/English. Opt-out is only ever
 * inferred from CONTACT verbs.
 *
 * INCIDENT 2026-08-23: a wildcard `jangan <anything> lagi` rule classified
 * "awak jangan tanya lagi" (stop asking me questions — ordinary conversational
 * impatience) as a permanent DO-NOT-CONTACT, which silenced the whole
 * conversation. Conversational verbs (tanya/soal/ulang/sebut) MUST NOT
 * ever trigger an opt-out.
 */
const CONTACT_VERBS =
  "whatsapp|wasap|wassap|wsap|mesej|message|msg|sms|contact|hubungi|call|telefon|tepon|hantar|kirim|ganggu|kacau|spam|promo|promosi|iklan|follow\\s?up|followup";

const OPT_OUT_PATTERNS: RegExp[] = [
  /\b(saya\s+)?(tak|tidak)\s+(ber)?minat\b/,
  /\bnot\s+interested\b/,
  new RegExp(`\\bjangan\\s+(${CONTACT_VERBS})\\b`),
  new RegExp(`\\bjangan\\s+(${CONTACT_VERBS})\\s+(saya|aku|i)?\\s*lagi\\b`),
  new RegExp(`\\b(berhenti|stop)\\s+(${CONTACT_VERBS})\\b`),
  /\bstop\s+(messages|messaging|contacting|calling|texting|sending)\b/,
  /\b(tak|tidak)\s+(nak|mahu)\s+(terima|dapat)\s+(promosi|promotion|mesej|message|iklan)\b/,
  /\bremove\s+(my|saya\s+punya)\s+(number|no|nombor|contact)\b/,
  /\b(buang|padam)\s+(nombor|no)\s+saya\b/,
  /\bno\s+more\s+messages?\b/,
  /\b(please\s+)?do\s?n'?t\s+contact\s+me(\s+again)?\b/,
  /\bdo\s+not\s+contact\s+me\b/,
  /\bremove\s+me\b/,
  /\bunsubscribe\b/,
  /\bopt\s?out\b/,
  new RegExp(`\\b(tak|tidak)\\s+(nak|mahu)\\s+(${CONTACT_VERBS})\\b`),
  /\btak\s+payah\s+follow\s?up\b/,
];


export type OptOutReading = { optedOut: boolean; matched: string | null };

/** Deterministic opt-out / do-not-contact detection (phrase-aware). */
export function detectOptOut(text: string | null | undefined): OptOutReading {
  const t = normalizeMessage(text);
  if (!t) return { optedOut: false, matched: null };
  for (const re of OPT_OUT_PATTERNS) {
    const m = t.match(re);
    if (m) return { optedOut: true, matched: m[0].trim() };
  }
  return { optedOut: false, matched: null };
}

/** True when ANY message in the conversation contains an explicit opt-out. */
export function conversationOptedOut(messages: string[]): OptOutReading {
  for (const m of messages) {
    const r = detectOptOut(m);
    if (r.optedOut) return r;
  }
  return { optedOut: false, matched: null };
}

/* ------------------------------------------------------------------ *
 * FIX 2 — frustration / repetition / context failure
 * ------------------------------------------------------------------ */

export type FrustrationSignal = "FRUSTRATED" | "REPETITION_COMPLAINT" | "CONTEXT_FAILURE";

const REPETITION_PATTERNS: RegExp[] = [
  /\b(dah|dh|sudah|saya\s+dah|sy\s+dah)\s+(explain|terangkan|bagitahu|bagitau|bgtau|bagi\s?tahu|bagi\s?tau|cakap|jawab|bagi|beritahu|inform|state|sebut)\b/,
  /\b(explain|cakap|bagitahu)\b[^.?!]{0,20}\bbanyak\s+kali\b/,
  /\basyik\s+tanya\b/,
  /\bkenapa\s+tanya\s+(lagi|balik)\b/,
  /\btanya\s+(benda|soalan)\s+(yang\s+)?sama\b/,
  /\bi'?ve\s+already\s+told\s+you\b/,
  /\bi\s+already\s+(told|answered|said)\b/,
  /\bwhy\s+do\s+you\s+keep\s+asking\b/,
  /\bstop\s+asking\s+the\s+same\b/,
  /\byou\s+keep\s+asking\s+the\s+same\b/,
];

const FRUSTRATION_PATTERNS: RegExp[] = [
  /\b(marah|kecewa|geram|menyampah|useless|teruk|annoying|frustrated|frustrating|complaint|komplen)\b/,
  /\b(lambat|slow\s+response|dah\s+lama\s+tunggu|no\s+reply|tak\s+jawab)\b/,
];

export function detectFrustration(text: string | null | undefined): FrustrationSignal[] {
  const t = normalizeMessage(text);
  if (!t) return [];
  const out = new Set<FrustrationSignal>();
  if (REPETITION_PATTERNS.some((re) => re.test(t))) {
    out.add("REPETITION_COMPLAINT");
    out.add("CONTEXT_FAILURE");
    out.add("FRUSTRATED");
  }
  if (FRUSTRATION_PATTERNS.some((re) => re.test(t))) out.add("FRUSTRATED");
  return Array.from(out);
}

/* ------------------------------------------------------------------ *
 * FIX 3 — hotel preference vs hotel objection
 * ------------------------------------------------------------------ */

const HOTEL_REJECTION_PATTERNS: RegExp[] = [
  /\bhotel\s+(ni|ini|tu|itu|this|that)\b[^.?!]{0,40}\b(jauh|far|tak\s+sesuai|tak\s+best|kecil|teruk|lama|old|tak\s+selesa)\b/,
  /\b(tak|tidak)\s+(nak|mahu|suka)\s+hotel\b/,
  /\bhotel\b[^.?!]{0,30}\b(jauh\s+sangat|terlalu\s+jauh|too\s+far)\b/,
  /\b(jauh\s+sangat|too\s+far)\b[^.?!]{0,40}\bhotel\b/,
  /\bhotel\s+(ni|ini|tu|itu)\b[^.?!]{0,60}\b(susah\s+berjalan|tak\s+boleh\s+jalan)\b/,
];

const HOTEL_PREFERENCE_PATTERNS: RegExp[] = [
  /\bhotel\b[^.?!]{0,30}\b(dekat|near|close)\b/,
  /\b(dekat|near|close(r)?)\b[^.?!]{0,20}\b(haram|masjid|kaabah|ka'?bah)\b/,
  /\bkalau\s+boleh\s+jangan\s+jauh\b/,
  /\b(prefer|lebih\s+suka|nak|want|would\s+like)\b[^.?!]{0,25}\bhotel\b/,
];

export type HotelReading = { preference: boolean; objection: boolean };

/**
 * A stated requirement ("hotel kalau boleh dekat") is a PREFERENCE.
 * Resistance to a proposed option ("hotel ni jauh sangat") is an OBJECTION.
 */
export function classifyHotelMention(text: string | null | undefined): HotelReading {
  const t = normalizeMessage(text);
  if (!t) return { preference: false, objection: false };
  const objection = HOTEL_REJECTION_PATTERNS.some((re) => re.test(t));
  if (objection) return { preference: false, objection: true };
  return { preference: HOTEL_PREFERENCE_PATTERNS.some((re) => re.test(t)), objection: false };
}

/* ------------------------------------------------------------------ *
 * FIX 4 — elderly / mobility / comfort requirements
 * ------------------------------------------------------------------ */

export type TravellerNeed =
  | "ELDERLY_TRAVELLER"
  | "MOBILITY_CONCERN"
  | "WALKING_DISTANCE_CONCERN"
  | "COMFORT_PRIORITY";

const ELDERLY_PATTERNS: RegExp[] = [
  /\b(bawa|bring|with|travel(ling)?\s+with)\b[^.?!]{0,20}\b(mak|emak|ibu|ayah|abah|bapa|parents?|mother|father|nenek|atuk)\b/,
  /\b(mak|emak|ibu|ayah|abah|bapa|mother|father|nenek|atuk)\b[^.?!]{0,20}\b(umur|aged?)\s*\d{2}\b/,
  /\bumur\s*(6\d|7\d|8\d|9\d)\b/,
  /\b(6\d|7\d|8\d|9\d)\s*(tahun|thn|years?\s*old|yo)\b/,
  /\b(mak|emak|ibu|ayah|abah|bapa|nenek|atuk|mother|father)\b[^.?!]{0,25}\b(6\d|7\d|8\d|9\d)\s*(tahun|thn|years?)\b/,
  /\b(mak|emak|ibu|ayah|abah|bapa|nenek|atuk)\b[^.?!]{0,20}\b(dah\s+)?(tua|uzur)\b/,
  /\belderly(\s+(mother|father|parents?))?\b/,
  /\bwarga\s+emas\b/,
  /\bsenior\s+citizens?\b/,
  /\bparents?\b/,
];

const MOBILITY_PATTERNS: RegExp[] = [
  /\bsusah\s+((nak|utk|untuk)\s+)?(berjalan|jalan)\b/,
  /\b(tak|tidak)\s+(larat|mampu)\s+((nak|utk|untuk)\s+)?(berjalan|jalan)\b/,
  /\b(tak|tidak)\s+boleh\s+jalan\b/,
  /\bwheelchair\b/,
  /\bkerusi\s+roda\b/,
  /\bmobility\b/,
  /\bwalking\s+difficult(y|ies)\b/,
  /\bcepat\s+penat\b/,
];

const WALKING_DISTANCE_PATTERNS: RegExp[] = [
  /\bjalan\s+jauh\b/,
  /\bwalking\s+distance\b/,
  /\btakut\s+jalan\b/,
  /\bwalk\s+(too\s+)?far\b/,
  /\bjauh\s+(dari|dgn|from)?\s*(haram|masjid)\b/,
];

const COMFORT_PATTERNS: RegExp[] = [
  /\bselesa\b/,
  /\bcomfort(able)?\b/,
  /\brisau\s+penat\b/,
  /\bpenat\b/,
];

export function detectTravellerNeeds(text: string | null | undefined): TravellerNeed[] {
  const t = normalizeMessage(text);
  if (!t) return [];
  const out = new Set<TravellerNeed>();
  if (ELDERLY_PATTERNS.some((re) => re.test(t))) out.add("ELDERLY_TRAVELLER");
  if (MOBILITY_PATTERNS.some((re) => re.test(t))) out.add("MOBILITY_CONCERN");
  if (WALKING_DISTANCE_PATTERNS.some((re) => re.test(t))) out.add("WALKING_DISTANCE_CONCERN");
  if (COMFORT_PATTERNS.some((re) => re.test(t))) out.add("COMFORT_PRIORITY");
  // An elderly traveller with a mobility or walking concern is, deterministically,
  // a comfort-priority customer requirement.
  if (
    out.has("ELDERLY_TRAVELLER") &&
    (out.has("MOBILITY_CONCERN") || out.has("WALKING_DISTANCE_CONCERN"))
  ) {
    out.add("COMFORT_PRIORITY");
  }
  return Array.from(out);
}

/* ------------------------------------------------------------------ *
 * FIX 8 — total vs per-person budget
 * ------------------------------------------------------------------ */

const WORD_NUMBERS: Record<string, number> = {
  se: 1, satu: 1, sorang: 1, seorang: 1, one: 1,
  dua: 2, berdua: 2, two: 2,
  tiga: 3, three: 3,
  empat: 4, four: 4,
  lima: 5, five: 5,
  enam: 6, six: 6,
};

export type BudgetReading = {
  totalBudgetMyr: number | null;
  perPersonBudgetMyr: number | null;
  pax: number | null;
};

const PER_PERSON_CONTEXT =
  /\b(per\s*(person|pax|orang|head)|seorang|sorang|setiap\s+orang|each|per\s?pax)\b/;
const TOTAL_CONTEXT =
  /\b(total|semua|kesemua|all\s+in|altogether|untuk\s+(dua|tiga|empat|lima|\d+)\s+(orang|jemaah|pax)|for\s+\d+\s+(people|persons?|pax))\b/;

function parseAmount(raw: string, suffix: string | undefined): number {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return NaN;
  if (suffix && /^(k|ribu)$/i.test(suffix)) return n * 1000;
  return n;
}

export function detectPax(text: string | null | undefined): number | null {
  const t = normalizeMessage(text);
  if (!t) return null;
  const digit = t.match(/\b(\d{1,2})\s*(orang|jemaah|pax|people|persons?)\b/);
  if (digit?.[1]) return Number(digit[1]);
  const word = t.match(/\b(satu|dua|tiga|empat|lima|enam|two|three|four|five|six)\s*(orang|jemaah|pax|people|persons?)\b/);
  if (word?.[1]) return WORD_NUMBERS[word[1]] ?? null;
  if (/\bberdua\b/.test(t)) return 2;
  return null;
}

/** Distinguish TOTAL_BUDGET from PER_PERSON_BUDGET without silent conversion. */
export function detectBudget(text: string | null | undefined): BudgetReading {
  const t = normalizeMessage(text);
  const result: BudgetReading = { totalBudgetMyr: null, perPersonBudgetMyr: null, pax: detectPax(t) };
  if (!t) return result;

  const money = /(?:rm\s?)?(\d[\d,]*(?:\.\d+)?)\s*(k|ribu)?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = money.exec(t))) {
    const hasCurrency = /rm/.test(m[0]) || Boolean(m[2]);
    const amount = parseAmount(m[1] ?? "", m[2]);
    if (!Number.isFinite(amount) || amount < 100) {
      if (!(hasCurrency && amount >= 1)) continue;
    }
    const before = t.slice(Math.max(0, m.index - 40), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const window = `${before} ${after}`;
    // Skip pilgrim counts and month numbers.
    if (/^\s*(orang|jemaah|pax|people|persons?|malam|nights?|hari|bintang|star)\b/.test(after)) continue;
    const budgetish = /\b(budget|bajet|rm|harga|price|kos|cost|mampu|afford)\b/.test(window) || /rm/.test(m[0]) || Boolean(m[2]);
    if (!budgetish) continue;

    if (PER_PERSON_CONTEXT.test(after) || PER_PERSON_CONTEXT.test(before)) {
      result.perPersonBudgetMyr = amount;
    } else if (TOTAL_CONTEXT.test(after) || TOTAL_CONTEXT.test(before)) {
      result.totalBudgetMyr = amount;
    } else if (result.totalBudgetMyr === null && result.perPersonBudgetMyr === null) {
      // Ambiguous: preserve the customer's words — record as per-person only when
      // a single traveller is implied, otherwise leave undecided as total.
      if (result.pax && result.pax > 1) result.totalBudgetMyr = amount;
      else result.perPersonBudgetMyr = amount;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * FIX 7 / FIX 9 — booking intent and recommendation requests
 * ------------------------------------------------------------------ */

const BOOKING_PATTERNS: RegExp[] = [
  /\bbook(ing|ed)?\b/,
  /\bnak\s+(buat\s+)?booking\b/,
  /\bmacam\s?mana\s+nak\s+book(ing)?\b/,
  /\bhow\s+(to|do\s+i|can\s+i)\s+book\b/,
  /\bboleh\s+booking\b/,
  /\bnak\s+confirm\b/,
];

/** Token-aware booking intent, evaluated AFTER negation masking. */
export function detectBookingIntent(text: string | null | undefined): boolean {
  const t = maskNegatedSpans(normalizeMessage(text));
  if (!t) return false;
  return BOOKING_PATTERNS.some((re) => re.test(t));
}

const RECOMMENDATION_PATTERNS: RegExp[] = [
  /\byang\s+mana\b/,
  /\bmana\s+(satu|paling|yg)\b/,
  /\bpaling\s+(sesuai|best|bagus|ok)\b/,
  /\bapa\s+yang\s+paling\s+sesuai\b/,
  /\bwhich\s+(one|package|is\s+suitable|do\s+you\s+recommend|should\s+i)\b/,
  /\brecommend\b/,
  /\bcadang(kan)?\b/,
  /\bsuggest\b/,
];

export function detectRecommendationRequest(text: string | null | undefined): boolean {
  const t = maskNegatedSpans(normalizeMessage(text));
  if (!t) return false;
  return RECOMMENDATION_PATTERNS.some((re) => re.test(t));
}

/** Deposit intent, normalisation- and negation-aware. */
export function detectDepositIntent(text: string | null | undefined): boolean {
  const t = maskNegatedSpans(normalizeMessage(text));
  if (!t) return false;
  return /\bdeposit\b/.test(t) || /\b(berapa|how\s+much)\b[^.?!]{0,25}\b(bayar|pay)\b/.test(t);
}

/* ------------------------------------------------------------------ *
 * FIX 5 — objection lifecycle
 * ------------------------------------------------------------------ */

export type ObjectionStatus = "ACTIVE" | "ADDRESSED" | "RESOLVED";

const RESOLUTION_PATTERNS: RegExp[] = [
  /\b(dah|sudah|already)\s+(bincang|discuss(ed)?|tanya|setuju|confirm|settle|fikir)\b/,
  /\b(husband|suami|wife|isteri|family|keluarga|mak|ayah)\s+(dah\s+)?(setuju|agree(d)?|ok(ay)?|sokong)\b/,
  /\bdah\s+confirm\s+dengan\s+(family|keluarga|suami|isteri)\b/,
  /\bdiscussed\s+and\s+(we'?re|i'?m)\s+ready\b/,
  /\bwe'?re\s+ready\s+to\s+proceed\b/,
  /\bokay\s+dah\b/,
  /\bkami\s+nak\s+proceed\b/,
  /\bsemua\s+dah\s+ok(ay)?\b/,
  /\b(ok(ay)?|oklah|takpe|tak\s+pe|tkpe|no\s+problem)\b[^.?!]{0,30}\b(faham|understand|terima|accept|boleh\s+terima|setuju|agree)\b/,
  /\b(boleh|dapat)\s+terima\b/,
  /\b(i\s+)?(understand|get\s+it)\b[^.?!]{0,20}\b(that'?s\s+)?(fine|ok(ay)?|acceptable)\b/,
];

/** True when the message resolves a previously raised concern (past tense). */
export function detectObjectionResolution(text: string | null | undefined): boolean {
  const t = normalizeMessage(text);
  if (!t) return false;
  return RESOLUTION_PATTERNS.some((re) => re.test(t));
}

export type ObjectionRecord<C extends string = string> = {
  category: C;
  status: ObjectionStatus;
  firstSeenTurn: number;
  lastSeenTurn: number;
  resolvedTurn: number | null;
};

/**
 * Build the objection lifecycle across a conversation.
 *
 * History is preserved: resolved objections stay on record but no longer block
 * conversion. `detect` is injected so this stays free of Step 3 imports.
 */
export function buildObjectionLifecycle<C extends string>(
  customerMessages: string[],
  detect: (text: string) => C[],
): Array<ObjectionRecord<C>> {
  const records = new Map<C, ObjectionRecord<C>>();
  customerMessages.forEach((message, turn) => {
    const resolving = detectObjectionResolution(message);
    if (resolving) {
      for (const rec of records.values()) {
        if (rec.status !== "RESOLVED") {
          rec.status = "RESOLVED";
          rec.resolvedTurn = turn;
        }
      }
    }
    for (const category of detect(message)) {
      const existing = records.get(category);
      if (!existing) {
        // A concern first voiced in the same breath as its resolution
        // ("dah bincang dengan husband, kami nak proceed") is already resolved.
        records.set(category, {
          category,
          status: resolving ? "RESOLVED" : "ACTIVE",
          firstSeenTurn: turn,
          lastSeenTurn: turn,
          resolvedTurn: resolving ? turn : null,
        });
      } else {
        existing.lastSeenTurn = turn;
        if (!resolving && existing.status === "RESOLVED") {
          // A genuinely new mention after resolution reopens it only when the
          // message is not itself resolution language.
          existing.status = "ACTIVE";
          existing.resolvedTurn = null;
        }
      }
    }
  });
  return Array.from(records.values());
}

/* ------------------------------------------------------------------ *
 * FIX 10 — deterministic human handoff request
 * ------------------------------------------------------------------ */

const HUMAN_REQUEST_PATTERNS: RegExp[] = [
  /\b(cakap|bercakap|bincang|berbual|contact|hubungi|sambung(kan)?|talk|speak|chat)\b[^.?!]{0,40}\b(manusia|human|staff|staf|agent|ejen|orang(\s+sebenar)?|person|admin|pegawai|manager|pengurus|customer service|cs)\b/,
  /\b(staff|staf|agent|ejen|admin|manusia|human|orang)\b[^.?!]{0,30}\b(call|telefon|hubungi|whatsapp|contact)\b[^.?!]{0,20}\b(saya|aku|me|i)\b/,
  /\b(real|live)\s+(person|agent|human)\b/,
  // Must name an explicit human/staff target. "nak bercakap dengan awak/kamu/RAIŌ"
  // refers to the AI itself and must NEVER trigger a handover.
  /\bnak\s+(cakap|bercakap)\s+dengan\s+(manusia|human|staff|staf|agent|ejen|orang|admin|pegawai|pengurus|manager|cs|customer\s+service|person|real\s+person)\b/,
  /\btransfer\s+(me\s+)?to\s+(a\s+)?(human|agent|staff|person)\b/,
];

/**
 * INCIDENT 2026-08-24 (B-3) — "Kenapa cakap macam robot? Cakap macam orang."
 * was read as an explicit human-handover request, which set ai_enabled=false
 * and silenced the conversation permanently. A comparison about HOW to speak
 * ("talk like a normal person") is a style instruction, never a request to be
 * transferred to a person.
 */
const MANNER_OF_SPEECH_PATTERNS: RegExp[] = [
  /\b(cakap|bercakap|berbual|jawab|balas|layan|bunyi|tulis|bercerita|speak|talk|sound|reply|write)\b[^.?!]{0,12}\b(macam|seperti|kayak|bagai|like)\b/,
];

export function detectHumanRequest(text: string | null | undefined): boolean {
  const t = normalizeMessage(text);
  if (!t) return false;
  // Manner-of-speech phrasing is stripped before matching, so a genuine
  // request in the same message ("cakap macam orang biasa, sambungkan saya
  // kepada staff") is still detected.
  const cleaned = MANNER_OF_SPEECH_PATTERNS.reduce((acc, re) => acc.replace(new RegExp(re, "g"), " "), t);
  return HUMAN_REQUEST_PATTERNS.some((re) => re.test(cleaned));
}

