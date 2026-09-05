/**
 * UMRAIO® STEP 3 — HUMAN-LIKE AUTONOMOUS SALES & CLOSING ENGINE™ (pure core).
 *
 * Deterministic, dependency-free conversation intelligence. Everything here is
 * pattern/rule based so it is cheap, testable and auditable; the model is only
 * asked to *speak* well, never to decide business state on its own.
 *
 * This module EXTENDS the Step 2 primitives in `sales-intent.core.ts`
 * (objections + buying signals) — it does not replace them.
 */

import {
  detectBuyingSignals,
  detectObjections,
  type BuyingSignal,
  type ObjectionType as BaseObjectionType,
} from "@/lib/sales-intent.core";
import {
  buildObjectionLifecycle,
  classifyHotelMention,
  detectBookingIntent,
  detectBudget,
  detectDepositIntent,
  detectFrustration,
  detectHumanRequest,
  detectObjectionResolution,
  detectOptOut,
  detectPax,
  detectRecommendationRequest,
  detectTravellerNeeds,
  maskNegatedSpans,
  normalizeMessage,
  type BudgetReading,
  type ObjectionRecord,
  type TravellerNeed,
} from "@/lib/sales/hardening.core";
import {
  behavioralInstruction,
  buildBehavioralProfile,
  type BehavioralProfile,
} from "@/lib/sales/behavioral.core";
import { lostStageIsContradicted } from "./lifecycle-reconciliation.core";

/* ------------------------------------------------------------------ *
 * 4-8. LANGUAGE INTELLIGENCE™
 * ------------------------------------------------------------------ */

/** Extensible language codes. Priority for V1: ms, en, mix. */
export type LanguageCode = "ms" | "en" | "mix" | "id" | "ar" | "zh" | "ta" | "ur" | "bn";
export type LanguagePreference = "auto" | LanguageCode;

export const CUSTOMER_LANGUAGES: Array<{ value: LanguagePreference; label: string }> = [
  { value: "auto", label: "Auto detect" },
  { value: "ms", label: "Bahasa Melayu (Malaysia)" },
  { value: "en", label: "English" },
  { value: "mix", label: "BM + English (Manglish)" },
  { value: "id", label: "Bahasa Indonesia" },
  { value: "ar", label: "Arabic" },
  { value: "zh", label: "Simplified Chinese" },
  { value: "ta", label: "Tamil" },
  { value: "ur", label: "Urdu" },
  { value: "bn", label: "Bengali" },
];

export const LANGUAGE_LABEL: Record<LanguagePreference, string> = CUSTOMER_LANGUAGES.reduce(
  (acc, l) => ({ ...acc, [l.value]: l.label }),
  {} as Record<LanguagePreference, string>,
);

/** Malay markers incl. common WhatsApp short forms and spelling variants. */
const MS_MARKERS =
  /\b(nak|tak|tk|xnak|xde|takde|tade|dgn|dengan|saya|sy|aku|kami|kita|boleh|blh|bole|berapa|brp|brape|harga|bulan|orang|org|jemaah|pakej|dekat|dkt|jauh|murah|mahal|bila|macam|mcm|mana|utk|untuk|ada|ade|tiada|nanti|dulu|sikit|skit|banyak|bagus|tolong|terima kasih|tq|assalamualaikum|salam|insya|inshaallah|puan|tuan|encik|isteri|suami|mak|ibu|ayah|keluarga|hotel dekat|nk|blm|belum|dah|dh|sudah|kalau|kalo|nk tanya|bincang|risau|takut|mampu|bayar|tempah|daftar)\b/gi;

const EN_MARKERS =
  /\b(i|we|you|the|is|are|can|could|would|want|need|how|much|price|package|hotel|month|people|person|book|booking|deposit|pay|payment|please|thanks|thank|sorry|available|cheaper|expensive|near|far|family|mother|father|elderly|discuss|quotation|quote|send|okay|ok)\b/gi;

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

export type LanguageReading = {
  language: LanguageCode;
  confidence: number;
  /** true when both BM and English are meaningfully present. */
  mixed: boolean;
};

/** Detect the conversational language of a single message. */
export function detectMessageLanguage(text: string | null | undefined): LanguageReading | null {
  const t = (text ?? "").trim();
  if (!t) return null;

  if (/[\u0600-\u06ff]/.test(t)) return { language: "ar", confidence: 0.9, mixed: false };
  if (/[\u4e00-\u9fff]/.test(t)) return { language: "zh", confidence: 0.9, mixed: false };
  if (/[\u0b80-\u0bff]/.test(t)) return { language: "ta", confidence: 0.9, mixed: false };
  if (/[\u0980-\u09ff]/.test(t)) return { language: "bn", confidence: 0.9, mixed: false };

  const ms = countMatches(t, MS_MARKERS);
  const en = countMatches(t, EN_MARKERS);
  const total = ms + en;
  if (total === 0) return null;

  const ratio = Math.max(ms, en) / total;
  const mixed = ms >= 1 && en >= 1 && ratio < 0.8;
  const language: LanguageCode = mixed ? "mix" : ms >= en ? "ms" : "en";
  // Confidence grows with evidence volume and dominance, capped at 0.95.
  const confidence = Math.min(0.95, Math.round((0.4 + ratio * 0.35 + Math.min(total, 6) * 0.04) * 100) / 100);
  return { language, confidence, mixed };
}

/**
 * Resolve the language to reply in.
 *
 * Preference is a hint, never a cage: when the customer writes in another
 * language we follow the customer (§7 — language switching must feel natural
 * and must never reset the conversation).
 */
export function resolveReplyLanguage(input: {
  agencyDefault?: string | null;
  leadPreference?: LanguagePreference | null;
  recentCustomerMessages: string[];
}): { language: LanguageCode | "auto"; source: "customer" | "lead_preference" | "agency" | "auto"; confidence: number } {
  const readings = input.recentCustomerMessages
    .slice(-4)
    .map(detectMessageLanguage)
    .filter((r): r is LanguageReading => Boolean(r));
  const latest = readings.length ? readings[readings.length - 1]! : null;

  if (latest && latest.confidence >= 0.55) {
    return { language: latest.language, source: "customer", confidence: latest.confidence };
  }
  const pref = input.leadPreference;
  if (pref && pref !== "auto") return { language: pref, source: "lead_preference", confidence: 0.6 };
  const agency = input.agencyDefault;
  if (agency && agency !== "auto") {
    const map: Record<string, LanguageCode> = { ms: "ms", en: "en", mix: "mix", ar: "ar" };
    const mapped = map[agency];
    if (mapped) return { language: mapped, source: "agency", confidence: 0.5 };
  }
  if (latest) return { language: latest.language, source: "customer", confidence: latest.confidence };
  return { language: "auto", source: "auto", confidence: 0.3 };
}

export type ConversationalStyle = "formal" | "professional" | "casual" | "whatsapp_casual" | "concise" | "detailed";

/** Detect how the customer writes so replies can match without mimicry. */
export function detectConversationalStyle(messages: string[]): ConversationalStyle {
  const recent = messages.slice(-5).filter(Boolean);
  if (!recent.length) return "professional";
  const joined = recent.join(" ");
  const avgWords = recent.reduce((n, m) => n + m.trim().split(/\s+/).length, 0) / recent.length;

  const formal = /\b(tuan|puan|encik|dear|sir|madam|yang berhormat|kindly|sekiranya|mohon)\b/i.test(joined);
  const shortForms =
    countMatches(joined, /\b(nk|tk|xde|dgn|utk|brp|mcm|dkt|skit|dh|blh|tq|pls|plz|u|ur|abis|jgn)\b/gi);

  if (avgWords <= 6 && shortForms >= 1) return "whatsapp_casual";
  if (formal && avgWords > 8) return "formal";
  if (avgWords <= 5) return "concise";
  if (avgWords >= 30) return "detailed";
  if (shortForms >= 2) return "casual";
  return "professional";
}

/* ------------------------------------------------------------------ *
 * 11. EMOTION / CONVERSATIONAL SIGNAL INTELLIGENCE
 * ------------------------------------------------------------------ */

export type ConversationalSignal =
  | "CONFIDENT"
  | "CURIOUS"
  | "INTERESTED"
  | "EXCITED"
  | "HESITANT"
  | "CONFUSED"
  | "PRICE_CONCERN"
  | "TRUST_CONCERN"
  | "FRUSTRATED"
  | "URGENT"
  | "READY_TO_BUY"
  | "NOT_INTERESTED"
  // Step 3.6 additions
  | "DO_NOT_CONTACT"
  | "REPETITION_COMPLAINT"
  | "CONTEXT_FAILURE"
  | "NOT_READY"
  | "READY_TO_BOOK"
  | "DEPOSIT_INTENT"
  | "RECOMMENDATION_REQUEST"
  | "HUMAN_REQUEST"
  | "HOTEL_PROXIMITY_PREFERENCE"
  | "ELDERLY_TRAVELLER"
  | "MOBILITY_CONCERN"
  | "WALKING_DISTANCE_CONCERN"
  | "COMFORT_PRIORITY";

/** `negative: true` rules read the raw message; positive rules read masked text. */
const SIGNAL_RULES: Array<{ signal: ConversationalSignal; re: RegExp; negative?: boolean }> = [
  { signal: "PRICE_CONCERN", negative: true, re: /\b(mahal|expensive|pricey|over\s?budget|tak\s?mampu|cannot\s+afford|murah\s+sikit|cheaper|diskaun|discount)\b/i },
  { signal: "TRUST_CONCERN", negative: true, re: /\b(scam|penipu|selamat\s+ke|betul\s+ke|trusted|licence|lesen|motac|review|ulasan|sah\s+ke)\b/i },
  { signal: "HESITANT", negative: true, re: /\b(hmm+|entah|tak\s?pasti|not\s+sure|fikir\s+dulu|think\s+about|nanti\s+dulu|belum\s+decide|belum\s+sedia|maybe|mungkin|takut)\b/i },
  { signal: "CONFUSED", negative: true, re: /\b(tak\s?faham|dont\s+understand|don'?t\s+get|maksud\s+(nya|apa)|apa\s+maksud|confuse[d]?|keliru)\b/i },
  { signal: "FRUSTRATED", negative: true, re: /\b(lambat|slow\s+response|dah\s+lama\s+tunggu|no\s+reply|tak\s+jawab|marah|kecewa|useless|teruk|complaint|komplen)\b/i },
  { signal: "URGENT", negative: true, re: /\b(urgent|segera|cepat|asap|hari\s+ini|today|esok|tomorrow|last\s+minute|kejar)\b/i },
  { signal: "READY_TO_BUY", re: /\b(nak\s+(book|tempah|daftar)|saya\s+ambil|i'?ll\s+take|confirm|proceed|go\s+ahead|deal)\b/i },
  { signal: "NOT_INTERESTED", negative: true, re: /\b(tak\s+jadi|tak\s+minat|tak\s+berminat|not\s+interested|cancel|batal|stop\s+(message|whatsapp)|jangan\s+hantar|unsubscribe|opt\s?out)\b/i },
  { signal: "EXCITED", re: /\b(alhamdulillah|masyaallah|best|excited|tak\s+sabar|can'?t\s+wait|great|superb)\b/i },
  { signal: "CURIOUS", re: /\b(macam\s?mana|how|apa\s+beza|what'?s\s+the\s+difference|boleh\s+terangkan|explain|detail|info)\b/i },
  { signal: "INTERESTED", re: /\b(berminat|interested|okay\s+juga|nampak\s+ok|sounds\s+good|boleh\s+tahu|nak\s+tahu)\b/i },
  { signal: "CONFIDENT", re: /\b(saya\s+dah\s+decide|dah\s+pilih|i'?ve\s+decided|we'?ll\s+go\s+with)\b/i },
];

/**
 * Step 3.6 — negative/customer-control intent is evaluated BEFORE positive
 * intent, and positive matchers only ever see negation-masked text.
 */
export function detectConversationalSignals(text: string | null | undefined): ConversationalSignal[] {
  if (!text) return [];
  const normalized = normalizeMessage(text);
  const masked = maskNegatedSpans(normalized);
  const out = new Set<ConversationalSignal>();

  // 1. Customer control first.
  const optOut = detectOptOut(text);
  if (optOut.optedOut) {
    out.add("DO_NOT_CONTACT");
    out.add("NOT_INTERESTED");
  }
  if (detectHumanRequest(text)) out.add("HUMAN_REQUEST");
  for (const f of detectFrustration(text)) out.add(f);

  // 2. Negated positive intent becomes explicit hesitation, never a buying signal.
  const positiveTokens = /\b(book|booking|deposit|berminat|interested|proceed|confirm)\b/;
  if (positiveTokens.test(normalized) && !positiveTokens.test(masked) && !optOut.optedOut) {
    out.add("NOT_READY");
    out.add("HESITANT");
  }

  // 3. Requirements / preferences (never objections by themselves).
  const hotel = classifyHotelMention(text);
  if (hotel.preference) out.add("HOTEL_PROXIMITY_PREFERENCE");
  for (const need of detectTravellerNeeds(text)) out.add(need as ConversationalSignal);

  // 4. Positive intent, on masked text only.
  if (!optOut.optedOut) {
    if (detectBookingIntent(text)) out.add("READY_TO_BOOK");
    if (detectDepositIntent(text)) out.add("DEPOSIT_INTENT");
    if (detectRecommendationRequest(text)) out.add("RECOMMENDATION_REQUEST");
  }

  for (const rule of SIGNAL_RULES) {
    const haystack = rule.negative ? normalized : masked;
    if (!rule.re.test(haystack)) continue;
    if (optOut.optedOut && !rule.negative) continue;
    out.add(rule.signal);
  }

  return Array.from(out);
}


/* ------------------------------------------------------------------ *
 * 12-13. OBJECTION INTELLIGENCE (extends Step 2 taxonomy)
 * ------------------------------------------------------------------ */

export type ObjectionCategory =
  | "PRICE"
  | "TRUST"
  | "HOTEL"
  | "FLIGHT"
  | "TIMING"
  | "FAMILY_DECISION"
  | "PAYMENT"
  | "PACKAGE_VALUE"
  | "COMPARISON"
  | "UNCERTAINTY"
  | "NEED_MORE_INFORMATION";

const BASE_TO_CATEGORY: Record<BaseObjectionType, ObjectionCategory> = {
  PRICE: "PRICE",
  TIMING: "TIMING",
  TRUST: "TRUST",
  COMPARISON: "COMPARISON",
  FAMILY_DECISION: "FAMILY_DECISION",
  DOCUMENTATION: "NEED_MORE_INFORMATION",
};

const EXTENDED_OBJECTIONS: Array<{ type: ObjectionCategory; re: RegExp }> = [
  { type: "HOTEL", re: /\b(hotel)\b[^.?!]{0,40}\b(jauh|dekat|far|distance|walking|jalan\s+kaki|kecil|lama|old|teruk)\b|\bjauh\s+(dari|dgn)?\s*(haram|masjid)\b/i },
  { type: "FLIGHT", re: /\b(flight|penerbangan|transit|airline|kapal\s?terbang|direct\s+flight|singgah)\b[^.?!]{0,40}\b(lama|jauh|susah|tak\s+selesa|banyak|berapa\s+kali)?\b/i },
  { type: "PAYMENT", re: /\b(ansuran|instal(l)?ment|bayar\s+dulu|payment\s+plan|boleh\s+bayar\s+bulanan|split\s+payment|deposit\s+tinggi)\b/i },
  { type: "PACKAGE_VALUE", re: /\b(apa\s+yang\s+termasuk|berbaloi|worth\s+it|value|dapat\s+apa|inclusion|termasuk\s+apa)\b/i },
  { type: "UNCERTAINTY", re: /\b(tak\s?pasti|not\s+sure|belum\s+decide|belum\s+fix|tengok\s+dulu|see\s+first|maybe)\b/i },
  { type: "NEED_MORE_INFORMATION", re: /\b(boleh\s+bagi\s+(detail|maklumat)|more\s+(info|details)|itinerary|jadual|senarai)\b/i },
];

/**
 * Full Step 3 objection taxonomy for one message.
 *
 * Step 3.6: a stated hotel REQUIREMENT ("kalau boleh hotel dekat Haram") is a
 * preference, not an objection. Only resistance to a proposed option counts.
 */
export function detectObjectionCategories(text: string | null | undefined): ObjectionCategory[] {
  if (!text) return [];
  const normalized = normalizeMessage(text);
  const base = detectObjections(normalized).map((o) => BASE_TO_CATEGORY[o]);
  const extended = EXTENDED_OBJECTIONS.filter((o) => o.re.test(normalized)).map((o) => o.type);
  const hotel = classifyHotelMention(text);
  const all = new Set<ObjectionCategory>([...base, ...extended]);
  if (!hotel.objection) all.delete("HOTEL");
  else all.add("HOTEL");
  return Array.from(all);
}


export const OBJECTION_PLAYBOOK: Record<ObjectionCategory, string> = {
  PRICE:
    "Acknowledge the budget concern honestly, restate what the price actually covers using verified package data, then offer a genuinely cheaper verified option or a smaller pilgrim count. Never invent a discount.",
  TRUST:
    "Acknowledge the concern, share only verified agency credentials from the knowledge base, and offer written documentation. Never fabricate licences, reviews or testimonials.",
  HOTEL:
    "Confirm the actual hotel named in the package data and, if proximity matters, compare with a verified closer package including the price difference. Never estimate walking distance that is not in the data.",
  FLIGHT:
    "State only the airline/route recorded in the package. If transit details are not recorded, say so and offer to confirm with the team.",
  TIMING:
    "Respect the timing, capture the intended month on the lead profile and schedule a follow-up instead of pushing.",
  FAMILY_DECISION:
    "Support the discussion: summarise the key facts in a form they can forward, and agree a specific time to check back.",
  PAYMENT:
    "Explain only verified deposit and payment terms from the quotation or knowledge base. Never invent instalment plans or payment links.",
  PACKAGE_VALUE:
    "List the actual inclusions from the package record and connect each to what the customer said matters to them.",
  COMPARISON:
    "Never criticise the other agency. Restate this package's verified specifics and let the comparison stand on facts.",
  UNCERTAINTY:
    "Slow down. Ask one focused question to uncover what is actually unresolved, then address only that.",
  NEED_MORE_INFORMATION:
    "Answer with search_knowledge / recommend_packages results only, and keep it short and scannable.",
};

/* ------------------------------------------------------------------ *
 * 9. CONVERSATION STATE MACHINE
 * ------------------------------------------------------------------ */

export type ConversationState =
  | "DISCOVERY"
  | "QUALIFICATION"
  | "PACKAGE_MATCH"
  | "CONSIDERATION"
  | "TRUST_BUILDING"
  | "OBJECTION"
  | "HESITATION"
  | "HIGH_INTENT"
  | "QUOTATION_READY"
  | "QUOTATION_SENT"
  | "QUOTATION_DISCUSSION"
  | "DEPOSIT_READY"
  | "HUMAN_HANDOFF"
  | "NURTURE"
  | "BOOKED"
  | "LOST"
  /** Step 3.6 — explicit customer opt-out. Highest priority state. */
  | "DO_NOT_CONTACT";

export type KnownFacts = {
  fullName?: string | null;
  phone?: string | null;
  city?: string | null;
  pax?: number | null;
  preferredMonth?: string | null;
  /** Per-person budget (existing column semantics). */
  budgetMyr?: number | null;
  /** Step 3.6 — separate total-trip budget, never conflated with per-person. */
  totalBudgetMyr?: number | null;
  packageInterest?: string | null;
  stage?: string | null;
  doNotContact?: boolean | null;
  travellerNeeds?: string[] | null;
};

export type QuotationSnapshot = {
  status: string;
  quotationNumber?: string | null;
  depositAmount?: number | null;
  total?: number | null;
} | null;

export type IntelligenceInput = {
  /** Chronological conversation, oldest first. */
  messages: Array<{ sender: "customer" | "ai" | "human"; body: string; created_at?: string }>;
  lead: KnownFacts | null;
  quotation: QuotationSnapshot;
  /** conversations.ai_enabled === false */
  humanTakeover: boolean;
  agencyDefaultLanguage?: string | null;
  leadLanguagePreference?: LanguagePreference | null;
  bookingConfirmed?: boolean;
};

export type NextBestAction =
  | "ASK_CLARIFYING_QUESTION"
  | "RECOMMEND_PACKAGE"
  | "EXPLAIN_VALUE"
  | "HANDLE_OBJECTION"
  | "PROVIDE_COMPARISON"
  | "BUILD_TRUST"
  | "CREATE_QUOTATION"
  | "SEND_QUOTATION"
  | "FOLLOW_UP"
  | "MOVE_TO_DEPOSIT_READY"
  | "ESCALATE"
  | "NURTURE"
  | "STOP"
  /** Step 3.6 — answer from what is already known instead of re-asking. */
  | "ANSWER_FROM_CONTEXT"
  /** Step 3.7 — behavioural actions. */
  | "SIMPLIFY_OPTIONS"
  | "SUPPORT_DECISION_MAKER"
  | "REDUCE_FRICTION";

export type ConversationIntelligence = {
  state: ConversationState;
  language: LanguageCode | "auto";
  languageSource: string;
  languageConfidence: number;
  style: ConversationalStyle;
  signals: ConversationalSignal[];
  objections: ObjectionCategory[];
  /** Objections seen anywhere in the conversation (objection memory, §13). */
  objectionMemory: ObjectionCategory[];
  /** Step 3.6 — full lifecycle: history preserved, resolved never blocks. */
  objectionLifecycle: Array<ObjectionRecord<ObjectionCategory>>;
  /** Objections that are still ACTIVE (unresolved). */
  activeObjections: ObjectionCategory[];
  buyingSignals: BuyingSignal[];
  known: string[];
  missing: string[];
  nextBestAction: NextBestAction;
  /** 0-1 heuristic confidence in the derived state. */
  confidence: number;
  latestCustomerMessage: string | null;
  /** Step 3.6 — deterministic customer-control + requirement outputs. */
  optOut: boolean;
  optOutPhrase: string | null;
  humanRequested: boolean;
  travellerNeeds: TravellerNeed[];
  budget: BudgetReading;
  hotelProximityPreference: boolean;
  /** Step 3.7 — behavioural sales psychology profile (observed behaviour only). */
  behavior: BehavioralProfile;
};



const DEPOSIT_ASK = /\b(brp|berapa)?\s*deposit\b|\bhow\s+(much|do)\s+.{0,20}(deposit|pay)\b|\bmacam\s?mana\s+nak\s+(bayar|book|tempah)\b|\bhow\s+(do\s+i|to)\s+(book|pay)\b/i;

export function buildConversationIntelligence(input: IntelligenceInput): ConversationIntelligence {
  const customerMessages = input.messages.filter((m) => m.sender === "customer").map((m) => m.body);
  const latest = customerMessages.length ? customerMessages[customerMessages.length - 1]! : null;

  const lang = resolveReplyLanguage({
    agencyDefault: input.agencyDefaultLanguage ?? null,
    leadPreference: input.leadLanguagePreference ?? null,
    recentCustomerMessages: customerMessages,
  });
  const style = detectConversationalStyle(customerMessages);

  const signals = detectConversationalSignals(latest);

  // Step 3.6 — customer-control state, evaluated before anything positive.
  // CURRENT-TURN RULE: opt-out is a decision about THIS inbound turn only. A
  // historical STOP (or a historical do_not_contact flag on the lead) must
  // never block a NEW customer-initiated turn — the customer came back on
  // their own. Outbound/proactive contact stays blocked by the lead flag in
  // the follow-up dispatcher.
  const optOutReading = detectOptOut(latest);

  const humanRequested = customerMessages.slice(-3).some((m) => detectHumanRequest(m));
  const frustration = detectFrustration(latest);
  const repetitionComplaint = frustration.includes("REPETITION_COMPLAINT");

  // Objection lifecycle: history preserved, resolution respected.
  const objectionLifecycle = buildObjectionLifecycle<ObjectionCategory>(
    customerMessages,
    detectObjectionCategories,
  );
  const resolvedCategories = new Set(
    objectionLifecycle.filter((o) => o.status === "RESOLVED").map((o) => o.category),
  );
  const latestResolves = detectObjectionResolution(latest);
  const objections = detectObjectionCategories(latest).filter(
    (o) => !(latestResolves && resolvedCategories.has(o)),
  );
  const objectionMemory = objectionLifecycle.map((o) => o.category);
  const activeObjections = objectionLifecycle
    .filter((o) => o.status !== "RESOLVED")
    .map((o) => o.category);

  const maskedLatest = maskNegatedSpans(normalizeMessage(latest));
  const buyingSignals = Array.from(
    new Set<BuyingSignal>([
      ...(optOutReading.optedOut ? [] : detectBuyingSignals(maskedLatest)),
      ...(!optOutReading.optedOut && detectBookingIntent(latest) ? (["READY_TO_BOOK"] as BuyingSignal[]) : []),
      ...(!optOutReading.optedOut && detectDepositIntent(latest) ? (["ASKED_HOW_TO_PAY"] as BuyingSignal[]) : []),
      ...(detectPax(latest) ? (["CONFIRMED_PAX"] as BuyingSignal[]) : []),
    ]),
  );

  // Step 3.6 — requirements captured from the whole conversation.
  const travellerNeeds = Array.from(
    new Set(customerMessages.flatMap((m) => detectTravellerNeeds(m))),
  );
  const budget = customerMessages
    .map((m) => detectBudget(m))
    .reduce<BudgetReading>(
      (acc, b) => ({
        totalBudgetMyr: b.totalBudgetMyr ?? acc.totalBudgetMyr,
        perPersonBudgetMyr: b.perPersonBudgetMyr ?? acc.perPersonBudgetMyr,
        pax: b.pax ?? acc.pax,
      }),
      { totalBudgetMyr: null, perPersonBudgetMyr: null, pax: null },
    );
  const hotelProximityPreference = customerMessages.some(
    (m) => classifyHotelMention(m).preference,
  );

  const lead = input.lead ?? {};
  const known: string[] = [];
  const missing: string[] = [];
  const track = (label: string, value: unknown) => {
    if (value !== null && value !== undefined && value !== "" && value !== 0) known.push(label);
    else missing.push(label);
  };
  track("name", lead.fullName);
  track("phone", lead.phone);
  track("city", lead.city);
  track("pilgrims", lead.pax ?? budget.pax);
  track("travel month", lead.preferredMonth);
  track(
    "budget",
    lead.budgetMyr ?? lead.totalBudgetMyr ?? budget.perPersonBudgetMyr ?? budget.totalBudgetMyr,
  );
  track("package interest", lead.packageInterest);

  const depositIntent =
    Boolean(latest && DEPOSIT_ASK.test(normalizeMessage(latest))) ||
    detectDepositIntent(latest) ||
    buyingSignals.includes("ASKED_HOW_TO_PAY");
  const recommendationRequest = detectRecommendationRequest(latest);
  const enoughForRecommendation =
    Boolean(lead.pax ?? budget.pax) &&
    Boolean(lead.preferredMonth) &&
    Boolean(lead.budgetMyr ?? lead.totalBudgetMyr ?? budget.totalBudgetMyr ?? budget.perPersonBudgetMyr);
  const qStatus = input.quotation?.status ?? null;

  // ---- state resolution (customer control > business events > keywords) ----
  let state: ConversationState;
  let confidence = 0.6;

  if (optOutReading.optedOut) {
    state = "DO_NOT_CONTACT";
    confidence = 0.95;
  } else if (input.humanTakeover || humanRequested) {
    state = "HUMAN_HANDOFF";
    confidence = 0.95;
  } else if (input.bookingConfirmed || lead.stage === "booked") {
    state = "BOOKED";
    confidence = 0.95;
  } else if (
    // PRECEDENCE: a persisted stage='lost' loses to stronger current evidence
    // (confirmed booking already handled above, or a live quotation). LOST must
    // reflect a genuinely lost commercial state, not a stale field.
    (lead.stage === "lost" && !lostStageIsContradicted({ leadStage: lead.stage, quotationStatus: qStatus })) ||
    signals.includes("NOT_INTERESTED")
  ) {
    state = "LOST";
    confidence = 0.7;
  } else if (qStatus === "accepted" || (qStatus && depositIntent)) {
    state = "DEPOSIT_READY";
    confidence = 0.85;
  } else if (qStatus && objections.length) {
    state = "QUOTATION_DISCUSSION";
    confidence = 0.8;
  } else if (qStatus && ["sent", "viewed", "discussing"].includes(qStatus)) {
    state = "QUOTATION_SENT";
    confidence = 0.85;
  } else if (objections.length) {
    state = "OBJECTION";
    confidence = 0.75;

  } else if (signals.includes("TRUST_CONCERN")) {
    state = "TRUST_BUILDING";
    confidence = 0.7;
  } else if (signals.includes("HESITANT") || signals.includes("CONFUSED")) {
    state = "HESITATION";
    confidence = 0.65;
  } else if (
    (buyingSignals.includes("READY_TO_BOOK") || buyingSignals.includes("ASKED_FOR_QUOTATION") || depositIntent) &&
    Boolean(lead.packageInterest || buyingSignals.includes("CHOSE_PACKAGE")) &&
    Boolean(lead.pax || buyingSignals.includes("CONFIRMED_PAX"))
  ) {
    state = "QUOTATION_READY";
    confidence = 0.85;
  } else if (buyingSignals.length >= 1 && (buyingSignals.includes("READY_TO_BOOK") || depositIntent)) {
    state = "HIGH_INTENT";
    confidence = 0.75;
  } else if (lead.packageInterest || buyingSignals.includes("CHOSE_PACKAGE")) {
    state = "CONSIDERATION";
    confidence = 0.7;
  } else if (known.length >= 4) {
    state = "PACKAGE_MATCH";
    confidence = 0.7;
  } else if (customerMessages.length <= 1 && missing.length >= 5) {
    state = "DISCOVERY";
    confidence = 0.6;
  } else {
    state = "QUALIFICATION";
    confidence = 0.6;
  }

  // ---- next best action ----
  let nextBestAction: NextBestAction;
  switch (state) {
    case "DO_NOT_CONTACT":
      nextBestAction = "STOP";
      break;
    case "BOOKED":
      nextBestAction = "STOP";
      break;
    case "LOST":
      nextBestAction = "NURTURE";
      break;
    case "HUMAN_HANDOFF":
      nextBestAction = input.humanTakeover ? "STOP" : "ESCALATE";
      break;
    case "DEPOSIT_READY":
      nextBestAction = "MOVE_TO_DEPOSIT_READY";
      break;
    case "QUOTATION_DISCUSSION":
    case "OBJECTION":
      nextBestAction = objections.includes("COMPARISON")
        ? "PROVIDE_COMPARISON"
        : objections.includes("TRUST")
          ? "BUILD_TRUST"
          : objections.includes("PACKAGE_VALUE")
            ? "EXPLAIN_VALUE"
            : "HANDLE_OBJECTION";
      break;
    case "QUOTATION_SENT":
      nextBestAction = "FOLLOW_UP";
      break;
    case "QUOTATION_READY":
      nextBestAction = "CREATE_QUOTATION";
      break;
    case "HIGH_INTENT":
      nextBestAction = missing.includes("pilgrims") || missing.includes("travel month")
        ? "ASK_CLARIFYING_QUESTION"
        : "RECOMMEND_PACKAGE";
      break;
    case "TRUST_BUILDING":
      nextBestAction = "BUILD_TRUST";
      break;
    case "HESITATION":
      nextBestAction = "ASK_CLARIFYING_QUESTION";
      break;
    case "CONSIDERATION":
      nextBestAction = "EXPLAIN_VALUE";
      break;
    case "PACKAGE_MATCH":
      nextBestAction = "RECOMMEND_PACKAGE";
      break;
    default:
      nextBestAction = "ASK_CLARIFYING_QUESTION";
  }

  // ---- Step 3.6 signal/state priority ladder ----
  const controlled = state === "DO_NOT_CONTACT" || state === "HUMAN_HANDOFF" || state === "BOOKED";
  if (!controlled) {
    // A recommendation request with sufficient verified information must never
    // be answered with yet another clarifying question.
    if (
      recommendationRequest &&
      enoughForRecommendation &&
      (nextBestAction === "ASK_CLARIFYING_QUESTION" || state === "PACKAGE_MATCH" || state === "CONSIDERATION")
    ) {
      nextBestAction = "RECOMMEND_PACKAGE";
    }
    // A repetition complaint outranks any clarifying question.
    if (repetitionComplaint && nextBestAction === "ASK_CLARIFYING_QUESTION") {
      nextBestAction = "ANSWER_FROM_CONTEXT";
    }
    if (signals.includes("FRUSTRATED") && !repetitionComplaint) nextBestAction = "ESCALATE";
  }

  // ---- Step 3.7 behavioural layer (additive; never overrides safety) ----
  const behavior = buildBehavioralProfile({
    customerMessages,
    agentMessages: input.messages.filter((m) => m.sender !== "customer").map((m) => m.body),
    optedOut: Boolean(optOutReading.optedOut),
    humanTakeover: input.humanTakeover ?? false,
    quotationStatus: input.quotation?.status ?? null,
    bookingConfirmed: input.bookingConfirmed ?? false,
    leadStage: lead.stage ?? null,
    knownCount: known.length,
  });

  if (!controlled && nextBestAction !== "ESCALATE" && nextBestAction !== "ANSWER_FROM_CONTEXT") {
    // Behavioural strategy only refines *how* to advance, never whether the
    // conversion state machine allows advancing.
    if (behavior.strategy === "SUPPORT_DECISION_PROCESS" && nextBestAction !== "CREATE_QUOTATION") {
      nextBestAction = "SUPPORT_DECISION_MAKER";
    } else if (
      behavior.strategy === "SIMPLIFY_CHOICES" &&
      (nextBestAction === "ASK_CLARIFYING_QUESTION" || nextBestAction === "RECOMMEND_PACKAGE")
    ) {
      nextBestAction = "SIMPLIFY_OPTIONS";
    } else if (
      behavior.strategy === "REDUCE_FRICTION" &&
      nextBestAction === "ASK_CLARIFYING_QUESTION"
    ) {
      nextBestAction = "REDUCE_FRICTION";
    } else if (
      behavior.strategy === "VALUE_CLARIFICATION" &&
      nextBestAction === "ASK_CLARIFYING_QUESTION"
    ) {
      nextBestAction = "EXPLAIN_VALUE";
    } else if (behavior.strategy === "BUILD_TRUST" && nextBestAction === "ASK_CLARIFYING_QUESTION") {
      nextBestAction = "BUILD_TRUST";
    }
  }

  return {

    state,
    language: lang.language,
    languageSource: lang.source,
    languageConfidence: lang.confidence,
    style,
    signals,
    objections,
    objectionMemory,
    objectionLifecycle,
    activeObjections,
    buyingSignals,
    known,
    missing,
    nextBestAction,
    confidence,
    latestCustomerMessage: latest,
    optOut: Boolean(optOutReading.optedOut),
    optOutPhrase: optOutReading.matched,
    humanRequested,
    travellerNeeds,
    budget,
    hotelProximityPreference,
    behavior,
  };
}


/* ------------------------------------------------------------------ *
 * 17 + 22. HUMAN-QUALITY RESPONSE / CLOSING GUIDANCE (prompt block)
 * ------------------------------------------------------------------ */

const LANGUAGE_DIRECTIVE: Record<LanguageCode | "auto", string> = {
  auto: "Reply in whatever language the customer's latest message uses.",
  ms: "Reply in natural Bahasa Melayu Malaysia as a Malaysian consultant writes on WhatsApp — not textbook Malay, not translated English.",
  en: "Reply in natural Malaysian English.",
  mix: "Reply in the natural BM + English mix Malaysians actually use on WhatsApp. Keep it effortless, never forced Manglish.",
  id: "Reply in natural Bahasa Indonesia.",
  ar: "Reply in natural Arabic.",
  zh: "Reply in Simplified Chinese.",
  ta: "Reply in Tamil.",
  ur: "Reply in Urdu.",
  bn: "Reply in Bengali.",
};

const STYLE_DIRECTIVE: Record<ConversationalStyle, string> = {
  formal: "Match their formal register. Use tuan/puan respectfully. Full sentences.",
  professional: "Warm, professional, clear. Full sentences but never stiff.",
  casual: "Relaxed and friendly, still respectful. Short sentences.",
  whatsapp_casual:
    "Match their short WhatsApp rhythm: 1-3 short lines, no formal preamble. Do not copy their abbreviations excessively.",
  concise: "Be brief — two short lines maximum plus one question.",
  detailed: "They write in detail: give a clear structured answer, still under 150 words.",
};

const ACTION_DIRECTIVE: Record<NextBestAction, string> = {
  ASK_CLARIFYING_QUESTION:
    "Ask ONE useful question that unlocks the next step. Never ask for anything already known.",
  RECOMMEND_PACKAGE:
    "Call recommend_packages and present at most 2-3 genuinely suitable options with their real RM prices, tied to what the customer said matters.",
  EXPLAIN_VALUE:
    "Explain what the package actually includes (from package data) and why it fits their stated priorities. No hype.",
  HANDLE_OBJECTION:
    "Acknowledge the concern in one sentence, answer it with verified facts, then propose one concrete next step.",
  PROVIDE_COMPARISON:
    "Compare the verified options side by side in plain terms. Never criticise other agencies, never invent competitor facts.",
  BUILD_TRUST:
    "Answer the trust question with verified agency information only, then offer written details. No fabricated proof.",
  CREATE_QUOTATION:
    "The customer is qualified and asking to move forward: call create_quotation now with the chosen package and pilgrim count, then send back message_to_send.",
  SEND_QUOTATION: "Deliver the existing quotation details exactly as the system generated them.",
  FOLLOW_UP:
    "The quotation is with the customer. Answer their actual reaction; if they need time, agree a specific check-back and call schedule_followup.",
  MOVE_TO_DEPOSIT_READY:
    "They are ready to commit. Confirm the quotation figures as issued, explain the deposit step exactly as recorded, and call request_human_handoff so a colleague completes payment and booking. Never claim payment received or booking confirmed.",
  ESCALATE:
    "The customer is unhappy or needs a person. Acknowledge sincerely, call escalate_to_human with an honest reason, and say truthfully what was recorded.",
  NURTURE: "Keep it light and respectful. Do not push. Leave the door open.",
  STOP: "A human is handling this conversation, or the customer asked not to be contacted. Do not send another sales message.",
  ANSWER_FROM_CONTEXT:
    "The customer says they already told you this. Do NOT ask another clarifying question. Acknowledge it honestly in one short line, then answer using the information already in this conversation and on the lead profile.",
  SIMPLIFY_OPTIONS:
    "The customer is carrying too much information. Narrow to one recommended verified package plus at most one alternative, one short reason each, then one clear question.",
  SUPPORT_DECISION_MAKER:
    "The customer must consult someone before deciding. Give a short forwardable summary of the verified key facts, and agree a specific time to check back. Never pressure them to decide alone.",
  REDUCE_FRICTION:
    "They are close but one thing is blocking them. Name and resolve that single blocker with verified facts, then ask for the next small commitment. Do not restart qualification.",
};


/** Prompt block injected into the sales system prompt. */
export function conversationIntelligenceInstruction(intel: ConversationIntelligence): string {
  const lines: string[] = [
    "HUMAN-LIKE SALES ENGINE (Step 3) — derived deterministically from this conversation. Treat it as authoritative situational awareness, not as text to repeat to the customer.",
    `Conversation state: ${intel.state} (confidence ${intel.confidence.toFixed(2)}).`,
    `Language to use: ${LANGUAGE_DIRECTIVE[intel.language]} (detected via ${intel.languageSource}, confidence ${intel.languageConfidence.toFixed(2)}). If the customer switches language, follow them immediately and keep every prior detail — a language switch never resets the conversation.`,
    `Conversational style: ${STYLE_DIRECTIVE[intel.style]}`,
    `Next best action: ${intel.nextBestAction} — ${ACTION_DIRECTIVE[intel.nextBestAction]}`,
  ];

  if (intel.known.length) {
    lines.push(
      `ALREADY KNOWN (never ask again): ${intel.known.join(", ")}. Re-asking known information is a failure.`,
    );
  }
  if (intel.missing.length) {
    lines.push(
      `Still unknown: ${intel.missing.join(", ")}. Collect at most one or two of these per message, and only when useful right now.`,
    );
  }
  if (intel.signals.length) {
    lines.push(`Conversational signals in the latest message: ${intel.signals.join(", ")}. Respond to the feeling as well as the question.`);
  }
  if (intel.buyingSignals.length) {
    lines.push(`Buying signals: ${intel.buyingSignals.join(", ")}. Move decisively toward the next commitment — do not ask "are you interested?".`);
  }
  if (intel.objections.length) {
    lines.push(
      "Objections in this message:\n" +
        intel.objections.map((o) => `- ${o}: ${OBJECTION_PLAYBOOK[o]}`).join("\n"),
    );
  }
  const remembered = intel.objectionMemory.filter((o) => !intel.objections.includes(o));
  const resolved = intel.objectionLifecycle.filter((o) => o.status === "RESOLVED").map((o) => o.category);
  const stillActive = remembered.filter((o) => intel.activeObjections.includes(o));
  if (stillActive.length) {
    lines.push(
      `OBJECTION MEMORY (raised earlier, still ACTIVE): ${stillActive.join(", ")}. Never recommend something that contradicts these without naming the trade-off.`,
    );
  }
  if (resolved.length) {
    lines.push(
      `RESOLVED OBJECTIONS (history only, do NOT reopen): ${resolved.join(", ")}. The customer already settled these — never re-litigate them and never let them block the next commitment.`,
    );
  }

  // Step 3.6 — customer control, requirements and budget dimension.
  if (intel.optOut) {
    lines.push(
      `DO-NOT-CONTACT: the customer explicitly opted out${intel.optOutPhrase ? ` ("${intel.optOutPhrase}")` : ""}. Send no promotional message, no follow-up and no further sales question.`,
    );
  }
  if (intel.humanRequested) {
    lines.push(
      "HUMAN REQUESTED: the customer asked for a real person. Human takeover has already been activated deterministically by the system — acknowledge briefly and stop selling.",
    );
  }
  if (intel.travellerNeeds.length) {
    lines.push(
      `CUSTOMER REQUIREMENTS (not objections): ${intel.travellerNeeds.join(", ")}. Treat these as buying criteria — factor them into every recommendation (hotel proximity, walking distance, comfort) using verified package data only.`,
    );
  }
  if (intel.hotelProximityPreference) {
    lines.push(
      "HOTEL_PROXIMITY_PREFERENCE: the customer prefers a hotel close to the Haram. This is a requirement, not a complaint — match it, do not defend against it.",
    );
  }
  if (intel.budget.totalBudgetMyr || intel.budget.perPersonBudgetMyr) {
    lines.push(
      `BUDGET DIMENSION: ${intel.budget.totalBudgetMyr ? `total trip budget RM${intel.budget.totalBudgetMyr}` : ""}${intel.budget.totalBudgetMyr && intel.budget.perPersonBudgetMyr ? " · " : ""}${intel.budget.perPersonBudgetMyr ? `per-person budget RM${intel.budget.perPersonBudgetMyr}` : ""}. Never silently convert one into the other; package prices are per person.`,
    );
  }


  lines.push(
    "CLOSING FRAMEWORK: discover → match → value → confirm → quote → handle objection → confirm fit → ask for the next commitment → deposit-ready. Only advance one step per message, and only when the customer's own words justify it.",
    "HUMAN QUALITY: write like an experienced Umrah consultant on WhatsApp. No 'Thank you for your enquiry, how may I assist you today?'. No 'Please provide the following information.' No bullet-point forms. One or two short paragraphs, then one clear question or next step.",
    "NEVER create false urgency, fake scarcity, fake discounts, fake testimonials or religious pressure. If asked whether you are AI, answer truthfully.",
  );

  lines.push(behavioralInstruction(intel.behavior));

  return lines.filter(Boolean).join("\n");
}

/* ------------------------------------------------------------------ *
 * 25. HUMAN HANDOFF BRIEF
 * ------------------------------------------------------------------ */

export function buildHandoffBrief(input: {
  intel: ConversationIntelligence;
  lead: KnownFacts | null;
  quotation: QuotationSnapshot;
  reason: string;
}): string {
  const l = input.lead ?? {};
  const q = input.quotation;
  return [
    `CUSTOMER: ${l.fullName ?? "Unknown"}${l.city ? ` (${l.city})` : ""}${l.phone ? ` · ${l.phone}` : ""}`,
    `INTENT: ${input.intel.state}${input.intel.buyingSignals.length ? ` · signals: ${input.intel.buyingSignals.join(", ")}` : ""}`,
    `PACKAGE: ${l.packageInterest ?? "not chosen yet"}`,
    `BUDGET: ${l.budgetMyr ? `RM${l.budgetMyr} per person` : "not stated"} · PILGRIMS: ${l.pax ?? "not stated"} · MONTH: ${l.preferredMonth ?? "not stated"}`,
    `OBJECTIONS: ${input.intel.objectionMemory.length ? input.intel.objectionMemory.join(", ") : "none recorded"}`,
    `QUOTATION: ${q ? `${q.quotationNumber ?? "issued"} · ${q.status}` : "none"}`,
    `LAST CUSTOMER MESSAGE: ${(input.intel.latestCustomerMessage ?? "(none)").slice(0, 300)}`,
    `MISSING INFO: ${input.intel.missing.length ? input.intel.missing.join(", ") : "none"}`,
    `RECOMMENDED NEXT ACTION: ${input.intel.nextBestAction}`,
    `REASON FOR HANDOFF: ${input.reason}`,
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * 27-28. CONVERSATION QUALITY / SALES OPPORTUNITY SCORING
 * ------------------------------------------------------------------ */

/**
 * Conversation quality score (0-100) computed from real conversation data.
 * Never a model guess, never a booking probability.
 */
export function conversationQualityScore(input: {
  messages: Array<{ sender: "customer" | "ai" | "human"; body: string }>;
  intel: ConversationIntelligence;
}): { score: number; factors: Record<string, number> } {
  const { messages, intel } = input;
  const customer = messages.filter((m) => m.sender === "customer");
  const agent = messages.filter((m) => m.sender !== "customer");

  const engagement = Math.min(25, customer.length * 3);
  const responsiveness = agent.length ? Math.min(15, Math.round((agent.length / Math.max(1, customer.length)) * 15)) : 0;
  const capture = Math.round((intel.known.length / 7) * 25);

  const progression: Record<ConversationState, number> = {
    DISCOVERY: 4,
    QUALIFICATION: 8,
    PACKAGE_MATCH: 12,
    CONSIDERATION: 14,
    TRUST_BUILDING: 12,
    OBJECTION: 12,
    HESITATION: 10,
    HIGH_INTENT: 18,
    QUOTATION_READY: 20,
    QUOTATION_SENT: 22,
    QUOTATION_DISCUSSION: 22,
    DEPOSIT_READY: 25,
    HUMAN_HANDOFF: 12,
    NURTURE: 6,
    BOOKED: 25,
    LOST: 0,
    DO_NOT_CONTACT: 0,
  };

  const objectionHandling = intel.objectionMemory.length ? (agent.length > 0 ? 10 : 4) : 5;

  const factors = {
    engagement,
    responsiveness,
    information_capture: capture,
    progression: progression[intel.state],
    objection_handling: objectionHandling,
  };
  const score = Math.max(
    0,
    Math.min(100, Object.values(factors).reduce((a, b) => a + b, 0)),
  );
  return { score, factors };
}
