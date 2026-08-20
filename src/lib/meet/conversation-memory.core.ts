/**
 * UMRAIO® STEP 3E.1 — LIVE CONVERSION HARDENING (additive, deterministic).
 *
 * This module adds four small, pure capabilities on top of the existing Meet
 * engines. It does NOT re-implement or replace them:
 *
 *   1. Safe conversation compaction so a long, legitimate sales conversation
 *      is never rejected. Deterministic engines still read the FULL history;
 *      only the model's message window is trimmed, and everything material is
 *      carried forward as an explicit context carry-over.
 *   2. Asked-question memory so a discovery question is never repeated.
 *   3. Register mirroring (BM / English / Manglish) as a prompt directive.
 *   4. Cold-start etiquette that applies once, then stops.
 *   5. Natural Malaysian spoken-register guidance.
 *
 * No database, schema, safety-gate or UI behaviour is touched here.
 */

import type { DemoMessage } from "@/lib/meet-executive.core";
import type { MeetIntelligence } from "./b2b-executive.core";
import type { ConversionRead } from "./b2b-conversion.core";
import type { SocialProfile } from "@/lib/sales/social-presence.core";

/* ------------------------------------------------------------------ *
 * 1. Conversation compaction
 * ------------------------------------------------------------------ */

/** Recent turns sent verbatim to the model. Older turns become carry-over. */
export const MEET_MODEL_TURN_WINDOW = 12;

/** Hard ceiling accepted from the client before anything is compacted. */
export const MEET_MAX_ACCEPTED_MESSAGES = 400;

export type CompactionResult = {
  messages: DemoMessage[];
  /** Number of older turns replaced by the carry-over summary. */
  dropped: number;
  compacted: boolean;
};

/**
 * Trim the model window to the most recent turns. The very first visitor
 * message is always preserved (it carries the opening intent), and the window
 * is aligned so the model still sees complete visitor/executive pairs.
 */
export function compactMeetConversation(
  messages: DemoMessage[],
  window: number = MEET_MODEL_TURN_WINDOW,
): CompactionResult {
  if (messages.length <= window) {
    return { messages, dropped: 0, compacted: false };
  }

  const first = messages[0]!;
  let tail = messages.slice(messages.length - window);

  // Never open the window on an executive turn — the model should always see
  // a visitor message first so the exchange reads coherently.
  while (tail.length && tail[0]!.role !== "visitor") tail = tail.slice(1);

  const keepFirst = first.role === "visitor" && !tail.includes(first);
  const out = keepFirst ? [first, ...tail] : tail;

  return {
    messages: out,
    dropped: messages.length - out.length,
    compacted: true,
  };
}

/**
 * Deterministic carry-over of everything material from the older turns.
 * Derived entirely from the existing engines reading the FULL history, so no
 * identity, agency fact, pain, objection, decision or buying signal is lost.
 */
export function buildCarryOver(input: {
  intel: MeetIntelligence;
  conversion: ConversionRead;
  social: SocialProfile;
  dropped: number;
}): string | null {
  const { intel, conversion, social, dropped } = input;
  if (dropped <= 0) return null;

  const f = intel.facts;
  const facts: string[] = [];
  if (f.salesTeam !== null) facts.push(`sales team = ${f.salesTeam}`);
  if (f.monthlyEnquiries !== null) facts.push(`monthly enquiries = ${f.monthlyEnquiries}`);
  if (f.channelWhatsapp) facts.push("primary channel = WhatsApp");
  if (f.crmNamed) facts.push(`existing tooling = ${f.crmNamed}`);
  if (f.responseSpeed) facts.push(`response speed = ${f.responseSpeed}`);
  if (f.followup) facts.push(`follow-up = ${f.followup}`);
  if (f.qualification) facts.push("qualification = MANUAL");
  if (f.prioritisation) facts.push(`prioritisation = ${f.prioritisation}`);
  if (f.quotation) facts.push("quotation = MANUAL");
  if (f.automation) facts.push(`automation = ${f.automation}`);

  const lines: string[] = [
    `CONTEXT CARRY-OVER — ${dropped} earlier turn(s) of THIS SAME conversation are no longer shown verbatim. They happened. Never restart, never re-introduce yourself, never re-greet, never re-ask what is recorded below.`,
  ];

  const name = social.address.name;
  const honorific = social.address.honorific;
  lines.push(
    `Person: ${name ? `${honorific ? `${honorific} ` : ""}${name}` : "name not given"}${
      honorific ? " (title stated by them or from trusted context — never invent one)" : ""
    }. Introduction already done: ${social.needsIntroduction ? "no" : "yes"}.`,
  );

  lines.push(`Agency facts established: ${facts.length ? facts.join("; ") : "none yet"}.`);
  lines.push(
    `Opportunities evidenced: ${
      intel.detectedGaps.length ? intel.detectedGaps.map((g) => g.label).join("; ") : "none yet"
    }.`,
  );

  const active = intel.objections.filter((o) => o.status === "ACTIVE").map((o) => o.category);
  const resolved = intel.objections.filter((o) => o.status === "RESOLVED").map((o) => o.category);
  lines.push(
    `Objections — active: ${active.length ? active.join(", ") : "none"}; already handled (do not reopen): ${
      resolved.length ? resolved.join(", ") : "none"
    }.`,
  );

  lines.push(
    `Conversion state: ${conversion.state}; commercial intent: ${conversion.commercialIntent}.`,
  );
  if (conversion.valueBridge)
    lines.push(
      `Value bridge already established around: ${conversion.valueBridge.businessGap}.`,
    );
  if (intel.diagnosis)
    lines.push(`Diagnosis already given: ${intel.diagnosis.primaryOpportunity.label}.`);

  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * 2. Asked-question memory
 * ------------------------------------------------------------------ */

export type DiscoveryTopic =
  | "name_address"
  | "team_size"
  | "enquiry_volume"
  | "response_time"
  | "followup_process"
  | "qualification"
  | "tools_crm"
  | "channel"
  | "bottleneck"
  | "quotation"
  | "marketing";

export const DISCOVERY_TOPIC_LABEL: Record<DiscoveryTopic, string> = {
  name_address: "their name / preferred form of address",
  team_size: "how many people are in the sales team",
  enquiry_volume: "how many enquiries they receive",
  response_time: "how fast enquiries are answered",
  followup_process: "how follow-up is done today",
  qualification: "how leads are qualified",
  tools_crm: "what tools or CRM they use today",
  channel: "which channel enquiries arrive on",
  bottleneck: "where the sales process breaks down",
  quotation: "how quotations are prepared",
  marketing: "how they generate enquiries / marketing",
};

/** Patterns matched against EXECUTIVE turns only, to see what was asked. */
const ASKED_PATTERNS: Array<{ topic: DiscoveryTopic; re: RegExp }> = [
  {
    topic: "name_address",
    re: /\b(nama\s+(dan\s+)?(panggilan|awak|encik|tuan)|panggilan\s+yang|how\s+(should|may|do)\s+i\s+(address|call)\s+you|your\s+name|siapa\s+saya\s+bercakap|boleh\s+saya\s+tahu\s+nama)\b/i,
  },
  {
    topic: "team_size",
    re: /\b(berapa\s+(ramai|orang|banyak\s+orang)[^?]{0,40}(team|staff|sales)|(team|staff|sales\s+team)[^?]{0,40}\bberapa\b|how\s+many\s+(people|staff|agents?|are\s+(in|on)\s+your\s+team)|size\s+of\s+your\s+(sales\s+)?team)\b/i,
  },
  {
    topic: "enquiry_volume",
    re: /\b(berapa\s+(banyak\s+)?enquiry|enquiry[^?]{0,30}\b(sebulan|berapa)|how\s+many\s+(enquiries|leads|messages)|lead\s+volume|enquir(y|ies)\s+(per|a)\s+month|anggaran\s+berapa\s+enquiry)\b/i,
  },
  {
    topic: "response_time",
    re: /\b(berapa\s+(lama|cepat)[^?]{0,40}(balas|reply|respon)|how\s+(long|fast|quickly)[^?]{0,40}(reply|respond|answer)|response\s+time|masa\s+untuk\s+balas)\b/i,
  },
  {
    topic: "followup_process",
    re: /\b(follow[\s-]?up[^?]{0,50}(macam\s?mana|bagaimana|how|process|proses|siapa|who)|(macam\s?mana|how\s+do\s+you)[^?]{0,40}follow[\s-]?up)\b/i,
  },
  {
    topic: "qualification",
    re: /\b(qualify|qualification|kelayakan|macam\s?mana[^?]{0,40}(saring|tapis)|how\s+do\s+you\s+(qualify|screen))\b/i,
  },
  {
    topic: "tools_crm",
    re: /\b(guna\s+(apa|sistem|tool|crm)|apa\s+(tool|sistem|crm)|what\s+(tools?|system|crm)\s+(do\s+you|are\s+you)|sistem\s+apa)\b/i,
  },
  {
    topic: "channel",
    re: /\b(channel|saluran|(enquiry|lead)[^?]{0,30}(masuk\s+(dari|melalui)|come\s+(in\s+)?(from|through))|whatsapp\s+atau|mostly\s+whatsapp)\b/i,
  },
  {
    topic: "bottleneck",
    re: /\b(bahagian\s+mana[^?]{0,40}(manual|lambat|tersekat)|di\s?mana[^?]{0,30}(masalah|tersekat)|where\s+(does|do)[^?]{0,40}(break|slow|stuck)|which\s+part[^?]{0,30}manual|apa\s+yang\s+paling\s+mencabar)\b/i,
  },
  {
    topic: "quotation",
    re: /\b(quotation|sebut\s?harga)[^?]{0,40}(macam\s?mana|bagaimana|how|siapa|berapa\s+lama)\b/i,
  },
  {
    topic: "marketing",
    re: /\b(marketing|iklan|ads?|campaign)[^?]{0,40}(macam\s?mana|bagaimana|how|guna|run)\b/i,
  },
];

/** Topics RAIŌ has already put as a question to the visitor. */
export function detectAskedTopics(messages: DemoMessage[]): DiscoveryTopic[] {
  const out = new Set<DiscoveryTopic>();
  for (const m of messages) {
    if (m.role !== "executive") continue;
    // Only consider turns that actually contain a question.
    if (!/[?？]/.test(m.content)) continue;
    for (const { topic, re } of ASKED_PATTERNS) {
      if (re.test(m.content)) out.add(topic);
    }
  }
  return Array.from(out);
}

/** Topics for which the visitor has already supplied a usable answer. */
export function answeredTopics(intel: MeetIntelligence, social: SocialProfile): DiscoveryTopic[] {
  const f = intel.facts;
  const out: DiscoveryTopic[] = [];
  if (social.address.name) out.push("name_address");
  if (f.salesTeam !== null) out.push("team_size");
  if (f.monthlyEnquiries !== null) out.push("enquiry_volume");
  if (f.responseSpeed) out.push("response_time");
  if (f.followup) out.push("followup_process");
  if (f.qualification) out.push("qualification");
  if (f.crmNamed || f.automation) out.push("tools_crm");
  if (f.channelWhatsapp) out.push("channel");
  if (f.quotation) out.push("quotation");
  if (f.marketing) out.push("marketing");
  if (intel.detectedGaps.length) out.push("bottleneck");
  return Array.from(new Set(out));
}

export type QuestionMemory = {
  asked: DiscoveryTopic[];
  answered: DiscoveryTopic[];
  /** Asked but still unanswered — may be re-approached only if truly needed. */
  askedUnanswered: DiscoveryTopic[];
  /** Never asked and not answered — the only fresh discovery questions. */
  available: DiscoveryTopic[];
  /** True when enough is known that another discovery question is wasteful. */
  sufficientEvidence: boolean;
};

export function buildQuestionMemory(
  messages: DemoMessage[],
  intel: MeetIntelligence,
  social: SocialProfile,
): QuestionMemory {
  const asked = detectAskedTopics(messages);
  const answered = answeredTopics(intel, social);
  const askedUnanswered = asked.filter((t) => !answered.includes(t));
  const available = (Object.keys(DISCOVERY_TOPIC_LABEL) as DiscoveryTopic[]).filter(
    (t) => !asked.includes(t) && !answered.includes(t),
  );
  const sufficientEvidence = intel.detectedGaps.length > 0 && answered.length >= 2;
  return { asked, answered, askedUnanswered, available, sufficientEvidence };
}

export function questionMemoryInstruction(mem: QuestionMemory): string {
  const lines: string[] = ["CONVERSATION MEMORY — question discipline (deterministic)."];

  if (mem.answered.length)
    lines.push(
      `Already answered by the visitor — NEVER ask again: ${mem.answered
        .map((t) => DISCOVERY_TOPIC_LABEL[t])
        .join("; ")}.`,
    );
  if (mem.asked.length)
    lines.push(
      `You already asked about: ${mem.asked.map((t) => DISCOVERY_TOPIC_LABEL[t]).join("; ")}. Do not repeat any of these questions in any wording.`,
    );
  if (mem.askedUnanswered.length)
    lines.push(
      `Asked but not clearly answered: ${mem.askedUnanswered
        .map((t) => DISCOVERY_TOPIC_LABEL[t])
        .join("; ")}. Let it go and move forward unless that exact fact is genuinely required to be useful; if so, ask it once, differently, and acknowledge you are circling back.`,
    );

  if (mem.sufficientEvidence)
    lines.push(
      "Enough evidence exists. Prefer diagnosis, consequence or a grounded demonstration over another discovery question.",
    );
  else if (mem.available.length)
    lines.push(
      `If you ask anything, pick the single highest-value question not yet covered: ${mem.available
        .slice(0, 4)
        .map((t) => DISCOVERY_TOPIC_LABEL[t])
        .join("; ")}.`,
    );
  else
    lines.push(
      "No fresh discovery question remains. Move to diagnosis, demonstration or the next step instead of asking anything.",
    );

  lines.push("Never ask two questions in one reply.");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * 3. Register mirroring
 * ------------------------------------------------------------------ */

export type MeetRegister = "BM" | "ENGLISH" | "MANGLISH_BM_LED" | "MANGLISH_EN_LED" | "UNKNOWN";

const MANGLISH_PARTICLES = /\b(la|lah|lor|meh|ah|kan|je|jer|kot|sikit|ok\s?la)\b/i;

/**
 * Resolve the register to mirror. Uses the existing language reading and adds
 * a BM-led / English-led distinction for mixed messages, so an English-led
 * Manglish visitor never receives a full formal BM reply.
 */
export function resolveMeetRegister(visitorMessages: string[]): MeetRegister {
  const recent = visitorMessages.filter(Boolean).slice(-3);
  if (!recent.length) return "UNKNOWN";
  const joined = recent.join(" ");

  const msHits = (
    joined.match(
      /\b(saya|kami|nak|tak|tapi|dengan|dgn|boleh|macam|mana|banyak|sempat|dah|belum|kena|guna|orang|bulan|team\s+saya|customer\s+saya|betul|selamat|bincang|mahal|murah|enquiry\s+banyak)\b/gi,
    ) ?? []
  ).length;
  const enHits = (
    joined.match(
      /\b(i|my|we|the|is|are|can|could|would|should|you|how|what|why|show|help|team|need|want|actually|but|really|reply|fast|enough|about|price|data|safe|secure|subscribe)\b/gi,
    ) ?? []
  ).length;

  const total = msHits + enHits;
  if (total === 0) return "UNKNOWN";

  const mixed = msHits >= 2 && enHits >= 2;
  const manglish = mixed || MANGLISH_PARTICLES.test(joined);

  if (manglish && mixed) return msHits >= enHits ? "MANGLISH_BM_LED" : "MANGLISH_EN_LED";
  if (msHits > enHits) return "BM";
  if (enHits > msHits) return "ENGLISH";
  return "MANGLISH_BM_LED";
}

const REGISTER_DIRECTIVE: Record<MeetRegister, string> = {
  BM: "The visitor is writing in Bahasa Melayu. Reply in natural conversational Malaysian BM — spoken business register, not translated formal Malay.",
  ENGLISH:
    "The visitor is writing in English. Reply in natural professional English. Do NOT switch them into full Bahasa Melayu.",
  MANGLISH_EN_LED:
    "The visitor is writing English-led Manglish (mostly English with some BM words). Mirror that exactly: reply mainly in natural English, keeping the BM words and Malaysian rhythm they used. Do NOT reply in full formal Bahasa Melayu — that would feel like being switched to another language.",
  MANGLISH_BM_LED:
    "The visitor is writing BM-led Manglish (mostly BM with English business words). Mirror that: conversational BM with the English business terms left in English.",
  UNKNOWN:
    "Language not yet established. Mirror whatever the visitor uses next; do not force a language.",
};

export function registerMirrorInstruction(register: MeetRegister): string {
  return [
    `REGISTER MIRRORING: ${register}. ${REGISTER_DIRECTIVE[register]}`,
    "Malaysian business terms stay in English where a Malaysian would naturally use them: sales, enquiry, follow-up, team, CRM, closing, quotation, booking, channel, demo, trial.",
    "Never translate your own sentence twice, never ask the visitor to pick a language, and never reset the conversation when the language shifts.",
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * 4. Cold-start consistency
 * ------------------------------------------------------------------ */

export function coldStartInstruction(input: {
  social: SocialProfile;
  visitorTurns: number;
  executiveTurns: number;
}): string {
  const isColdStart = input.executiveTurns === 0;
  const nameKnown = Boolean(input.social.address.name);

  if (isColdStart) {
    return [
      "COLD START — this is your first reply in this conversation. Establish social presence BEFORE any demonstration, diagnosis or business question:",
      input.social.greetedWithSalam
        ? "1) Return their salam naturally (Waalaikumsalam)."
        : "1) Greet naturally and warmly, in their register. Do not open with salam if they did not.",
      '2) Introduce yourself ONCE, canonically — English: "I\'m RAIŌ — UMRAIO\'s AI Autonomous Business Executive™."; Bahasa Melayu: "Saya RAIŌ — AI Autonomous Business Executive™ daripada UMRAIO."',
      nameKnown
        ? "3) They already gave a name — use it, do not ask again."
        : "3) Ask who you are speaking with and how they prefer to be addressed. Ask nothing else in this reply.",
      "Even if their first message already asks for a demonstration, complete this social opening first and offer the demonstration in the same short reply as the next step.",
    ].join("\n");
  }

  return [
    "ESTABLISHED CONVERSATION — the social opening is already done. Do NOT greet again, do NOT say salam again, do NOT re-introduce yourself, do NOT restate your title. Continue naturally from the last exchange.",
    nameKnown
      ? `Use their name naturally and sparingly (not in every sentence).`
      : "Their name is still unknown. Do not keep asking for it — ask at most once more, only when it fits naturally.",
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * 5. Natural Malaysian spoken register
 * ------------------------------------------------------------------ */

export const MALAYSIAN_REGISTER_INSTRUCTION = [
  "NATURAL MALAYSIAN SPOKEN REGISTER — write the way a sharp Malaysian business executive actually speaks, not like translated corporate Malay.",
  'Never use these translated/corporate constructions: "membantu melaksanakan tindakan", "sempat layani", "pengasingan mengikut tenant", "melaksanakan proses", "penyelesaian bersepadu", "mengoptimumkan", "merekod secara sistematik", "pihak tuan/puan".',
  'Prefer natural alternatives: "UMRAIO boleh buat tindakan tu", "sempat layan", "bahagian mana masih manual", "enquiry mudah senyap", "team tak sempat balas", "saya boleh tunjuk".',
  'Avoid the formal brochure "anda" as a default form of address; speak directly or use their name.',
  "Explain technical behaviour in language an agency owner uses: say each agency's data is kept separate and only their own team can see it, rather than naming architecture. Never invent certifications, audits, compliance marks or guarantees.",
  "Stay professional: concise, specific, first person, no filler, no hype, no emojis, no markdown headings.",
].join("\n");
