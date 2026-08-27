import { agencyIdentityInstruction } from "@/lib/sales/unified-identity.core";
import { ISLAMIC_ELITE_PERSONA_AGENCY_INSTRUCTION } from "@/lib/sales/islamic-elite-persona.core";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { GLOBAL_UMRAIO_KNOWLEDGE } from "./global-knowledge.server";
// Provider-agnostic: sales AI talks to the Intelligence Gateway only.
import { createIntelligenceGateway } from "./ai/gateway.server";
import { newCorrelationId } from "./ai/context.server";
import { createSdkTools } from "./ai/sdk-tools.server";
import {
  createToolRegistry,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolRegistry,
} from "./ai/tool-registry.server";
import { hashContext, recordExperience } from "./ai/evaluation.server";
import { assertQuota, recordUsageEvent } from "./billing/usage.server";
import {
  classifyIslamicRisk,
  islamicRiskInstruction,
  mayEscalateIslamicReview,
} from "./islamic/risk.core";

import { createIslamicPolicyChecker } from "./islamic/policy.server";
import {
  DOMAIN_ISOLATION_INSTRUCTION,
  conversionSignalInstruction,
  intentAnchorInstruction,
} from "./sales-intent.core";
import {
  missingQuotationInputInstruction,
  emptyCompletionReply,
  isLiveQuotationRejection,
  type ToolRejectionRecord,
} from "./quotations/closing.core";

import {
  continuityInstruction,
  inferModalityFromBody,
  readContinuity,
} from "@/lib/sales/context-continuity.core";

import {
  buildConversationIntelligence,
  buildHandoffBrief,
  conversationIntelligenceInstruction,
  conversationQualityScore,
  type ConversationIntelligence,
  type LanguagePreference,
} from "./sales/conversation-intelligence.core";
import { applySafetyGate } from "./sales/safety-gate.server";
import {
  capabilityTruthInstructions,
  customerAskedAboutAiIdentity,
  customerAskedForLiveCall,
  sanitizeCapabilityClaims,
} from "./sales/capability-truth.core";
import { buildSocialProfile, socialPresenceInstruction } from "./sales/social-presence.core";
import {
  buildConfidenceRead,
  confidentPresenceInstruction,
} from "./sales/confident-presence.core";
import {
  buildEliteRead,
  eliteSalesInstruction,
  type EliteRead,
} from "./sales/elite/elite-sales.core";

import {
  collectSuppressedTopics,
  countSuppressedOccurrences,
  redactSuppressedTopics,
  sanitizeHistory,
  suppressionInstruction,
} from "./topic-suppression.core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

export type ChatMessageRow = {
  id: string;
  conversation_id: string;
  sender: "customer" | "ai" | "human";
  body: string;
  created_at: string;
};

/** Safe build/revision identifier for diagnostics (never a secret). */
const BUILD_REVISION = process.env["BUILD_REVISION"] ?? "umraio-6.4a-fix";

/** Non-reversible short reference for a conversation id (diagnostics only). */
function safeConversationRef(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `c_${(h >>> 0).toString(16)}`;
}

export async function loadContext(supabase: Db, conversationId: string) {
  const { data: conversation, error } = await supabase
    .from("conversations")
    .select("id, agency_id, lead_id, channel, status, ai_enabled, conversation_state")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw error;
  if (!conversation) throw new Error("Conversation not found");

  const [
    { data: messages },
    { data: lead },
    { data: packages },
    { data: agency },
    { data: knowledge },
    { data: settings },
  ] = await Promise.all([
    supabase
      .from("messages")
      .select("id, conversation_id, sender, body, created_at")
      .eq("conversation_id", conversationId)
      // Newest 200 messages (DESC + LIMIT), reversed below to chronological
      // order. Ascending+limit loaded the OLDEST 200 and dropped recent turns.
      .order("created_at", { ascending: false })
      .limit(200),
    conversation.lead_id
      ? supabase
          .from("leads")
          .select(
            "id, full_name, phone, email, stage, temperature, budget_myr, pax, preferred_month, city, package_interest, tags, score, preferred_language, detected_language, language_confidence, conversational_style, do_not_contact, total_budget_myr, budget_basis, traveller_needs",
          )
          .eq("id", conversation.lead_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // TENANT SCOPE: this runs on the service client, so the agency filter is
    // the ONLY thing keeping another agency's catalogue out of the prompt.
    // Without it the model can pick a foreign package_id and create_quotation
    // rejects it with "That package does not belong to this agency."
    supabase
      .from("packages")
      .select(
        "id, name, hotel_makkah, hotel_madinah, star_rating, nights, departure_date, airline, price_myr, inclusions, halal_review_status",
      )
      .eq("agency_id", conversation.agency_id)
      .eq("is_active", true)
      .order("price_myr", { ascending: true })
      .limit(30),
    supabase
      .from("agencies")
      .select("name, country, timezone")
      .eq("id", conversation.agency_id)
      .maybeSingle(),
    supabase
      .from("knowledge_articles")
      .select("id, title, category, summary, content, tags, file_name")
      .eq("agency_id", conversation.agency_id)
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(100),
    supabase
      .from("agency_settings")
      .select(
        "business_hours, ai_name, ai_personality, ai_tone, ai_reply_length, ai_language, ai_custom_instructions, ai_emoji, kb_strict_mode, kb_auto_use, kb_max_articles, kb_escalate_when_unknown",
      )
      .eq("agency_id", conversation.agency_id)
      .maybeSingle(),
  ]);

  // Step 3: the live quotation is part of the conversation's business state.
  const { data: quotation } = conversation.lead_id
    ? await supabase
        .from("quotations")
        .select("quotation_number, status, total, deposit_amount, created_at")
        .eq("agency_id", conversation.agency_id)
        .eq("lead_id", conversation.lead_id)
        .in("status", ["ready", "sent", "viewed", "discussing", "accepted"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  return {
    conversation,
    messages: [...((messages ?? []) as ChatMessageRow[])].reverse(),
    lead,
    quotation,
    packages: packages ?? [],
    agency,
    knowledge: (knowledge ?? []) as KnowledgeRow[],
    settings: (settings ?? null) as AgencyAiSettings | null,
  };
}

export type AgencyAiSettings = {
  business_hours: Record<string, { open: string; close: string; closed: boolean }> | null;
  ai_name: string;
  ai_personality: string;
  ai_tone: string;
  ai_reply_length: string;
  ai_language: string;
  ai_custom_instructions: string | null;
  ai_emoji: boolean;
  kb_strict_mode: boolean;
  kb_auto_use: boolean;
  kb_max_articles: number;
  kb_escalate_when_unknown: boolean;
};

export type KnowledgeRow = {
  id: string;
  title: string;
  category: string;
  summary: string | null;
  content: string;
  tags: string[] | null;
  file_name: string | null;
};

function scoreArticle(article: KnowledgeRow, terms: string[]) {
  const haystack = [
    article.title,
    article.summary,
    article.category,
    (article.tags ?? []).join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const body = article.content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (haystack.includes(term)) score += 3;
    if (body.includes(term)) score += 1;
  }
  return score;
}

export function searchKnowledge(
  articles: KnowledgeRow[],
  query: string,
  category?: string | null,
  limit = 4,
) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/)
    .filter((t) => t.length > 2);
  const pool = category ? articles.filter((a) => a.category === category) : articles;
  const ranked = pool
    .map((a) => ({ article: a, score: scoreArticle(a, terms) }))
    .sort((a, b) => b.score - a.score);
  const max = Math.min(Math.max(limit, 1), 8);
  const hits = ranked.filter((r) => r.score > 0).slice(0, max);
  const chosen = (hits.length ? hits : ranked.slice(0, Math.min(2, max))).map((r) => r.article);
  return chosen.map((a) => ({
    title: a.title,
    category: a.category,
    summary: a.summary,
    source_document: a.file_name,
    excerpt: a.content.slice(0, 2500),
  }));
}

/** Search the tenant-agnostic global UMRAIO knowledge (platform facts only). */
export function searchGlobalKnowledge(query: string, limit = 4) {
  const rows: KnowledgeRow[] = GLOBAL_UMRAIO_KNOWLEDGE.map((a) => ({
    id: a.id,
    title: a.title,
    category: a.category,
    summary: a.summary,
    content: a.content,
    tags: a.tags,
    file_name: null,
  }));
  return searchKnowledge(rows, query, null, limit).map((r) => ({
    ...r,
    source: "global" as const,
  }));
}

const PERSONALITY_HINTS: Record<string, string> = {
  professional: "Corporate, precise and credible. No filler, no slang.",
  friendly: "Warm, conversational and approachable, like a trusted travel consultant.",
  consultative: "Advisory: dig deeper with thoughtful qualifying questions before recommending.",
  concise: "Short, direct and always closing with a clear next step.",
};

const LENGTH_HINTS: Record<string, string> = {
  short: "Keep replies under 45 words.",
  balanced: "Keep replies under 90 words.",
  detailed: "Keep replies under 150 words.",
};

const LANGUAGE_HINTS: Record<string, string> = {
  auto: "Reply in the same language the customer uses (Bahasa Malaysia, English or a mix).",
  ms: "Always reply in Bahasa Malaysia.",
  en: "Always reply in English.",
  mix: "Reply in a natural Bahasa Malaysia and English mix, as Malaysians commonly write.",
  ar: "Always reply in Arabic.",
};

function businessHoursLine(settings: AgencyAiSettings | null) {
  const hours = settings?.business_hours;
  if (!hours) return null;
  const labels: Record<string, string> = {
    mon: "Mon",
    tue: "Tue",
    wed: "Wed",
    thu: "Thu",
    fri: "Fri",
    sat: "Sat",
    sun: "Sun",
  };
  const parts = Object.entries(labels).map(([key, label]) => {
    const day = hours[key];
    if (!day || day.closed) return `${label}: closed`;
    return `${label}: ${day.open}-${day.close}`;
  });
  return `Agency business hours (${parts.join(", ")}). Outside these hours, tell the customer a human colleague will follow up when the office reopens.`;
}

/** Single authoritative suppression state for one reply generation. */
export function collectContextSuppression(ctx: { messages: ChatMessageRow[] }): string[] {
  return collectSuppressedTopics(
    ctx.messages.filter((m) => m.sender === "customer").map((m) => m.body),
  );
}

/**
 * Step 3 — deterministic conversation intelligence for the current turn.
 * Pure derivation from real conversation, lead and quotation data.
 */
export function buildIntelligence(ctx: Awaited<ReturnType<typeof loadContext>>): ConversationIntelligence {
  const lead = ctx.lead as Record<string, unknown> | null;
  const q = ctx.quotation as Record<string, unknown> | null;
  return buildConversationIntelligence({
    messages: ctx.messages.map((m) => ({ sender: m.sender, body: m.body, created_at: m.created_at })),
    lead: lead
      ? {
          fullName: (lead["full_name"] as string | null) ?? null,
          phone: (lead["phone"] as string | null) ?? null,
          city: (lead["city"] as string | null) ?? null,
          pax: (lead["pax"] as number | null) ?? null,
          preferredMonth: (lead["preferred_month"] as string | null) ?? null,
          budgetMyr: lead["budget_myr"] === null ? null : Number(lead["budget_myr"]),
          packageInterest: (lead["package_interest"] as string | null) ?? null,
          stage: (lead["stage"] as string | null) ?? null,
          totalBudgetMyr:
            lead["total_budget_myr"] == null ? null : Number(lead["total_budget_myr"]),
          doNotContact: lead["do_not_contact"] === true,
        }
      : null,
    quotation: q
      ? {
          status: String(q["status"]),
          quotationNumber: (q["quotation_number"] as string | null) ?? null,
          total: q["total"] === null ? null : Number(q["total"]),
          depositAmount: q["deposit_amount"] === null ? null : Number(q["deposit_amount"]),
        }
      : null,
    humanTakeover: ctx.conversation.ai_enabled === false,
    agencyDefaultLanguage: ctx.settings?.ai_language ?? null,
    leadLanguagePreference: (lead?.["preferred_language"] as LanguagePreference | null) ?? null,
  });
}

/**
 * STEP 3I.1 — AI SALES ELITE™. Elite sales & closing read for this turn,
 * layered on the existing deterministic conversation intelligence.
 */
export function buildEliteIntelligence(
  ctx: Awaited<ReturnType<typeof loadContext>>,
  intel: ConversationIntelligence = buildIntelligence(ctx),
): EliteRead {
  const customerMessages = ctx.messages.filter((m) => m.sender === "customer");
  const lastCustomerAt = customerMessages.length
    ? new Date(customerMessages[customerMessages.length - 1]!.created_at).getTime()
    : null;
  const q = ctx.quotation as Record<string, unknown> | null;

  return buildEliteRead({
    domain: "agency_customer",
    customerMessages: customerMessages.map((m) => m.body),
    upstreamState: intel.nextBestAction,
    signals: intel.signals,
    activeObjections: intel.activeObjections,
    resolvedObjections: intel.objectionLifecycle
      .filter((o) => o.status === "RESOLVED")
      .map((o) => o.category),
    buyingSignals: intel.buyingSignals,
    known: intel.known,
    missing: intel.missing,
    optOut: intel.optOut,
    humanRequested: intel.humanRequested,
    quotationStatus: q ? String(q["status"]) : null,
    humanTakeover: ctx.conversation.ai_enabled === false,
    hoursSinceCustomerMessage:
      lastCustomerAt === null ? null : Math.max(0, (Date.now() - lastCustomerAt) / 3_600_000),
  });
}



function systemPrompt(
  ctx: Awaited<ReturnType<typeof loadContext>>,
  suppressedTopics: string[] = collectContextSuppression(ctx),
  intel: ConversationIntelligence = buildIntelligence(ctx),
) {
  const agencyName = (ctx.agency as { name?: string } | null)?.name ?? "our agency";
  const s = ctx.settings;
  const aiName = s?.ai_name?.trim() || "UMRAIO";
  const personality =
    PERSONALITY_HINTS[s?.ai_personality ?? "professional"] ?? PERSONALITY_HINTS["professional"];
  const length = LENGTH_HINTS[s?.ai_reply_length ?? "balanced"] ?? LENGTH_HINTS["balanced"];
  const language = LANGUAGE_HINTS[s?.ai_language ?? "auto"] ?? LANGUAGE_HINTS["auto"];
  const tone = s?.ai_tone ?? "warm";
  const useKb = s?.kb_auto_use ?? true;
  const lastCustomer = [...ctx.messages].reverse().find((m) => m.sender === "customer");
  // ISLAMIC IMPLEMENTATION LAYER™ V2.3 — risk-based routing. Basic Islamic
  // knowledge is answered directly; only HIGH_RISK reaches a human reviewer.
  const islamicRisk = classifyIslamicRisk(lastCustomer?.body);
  console.log(
    `[islamic] ISLAMIC_RISK_CLASSIFICATION classification=${islamicRisk.tier ?? "NONE"} reason=${islamicRisk.reason} conversation_id=${ctx.conversation.id}`,
  );
  const religiousBoundary = islamicRiskInstruction(islamicRisk.tier);

  const suppression = suppressionInstruction(suppressedTopics);
  const continuity = readContinuity({
    turns: ctx.messages.map((m) => ({ sender: m.sender, body: m.body })),
    latestCustomerMessage: redactSuppressedTopics(lastCustomer?.body, suppressedTopics),
    modality: inferModalityFromBody(lastCustomer?.body),
  });
  if (continuity.telemetry.length) {
    // Labels only — never sender identity, never message contents.
    console.log(`[sales-ai] continuity ${continuity.telemetry.join(",")}`);
  }



  return [
    `You are ${aiName}, the AI Autonomous Business Executive for ${agencyName}, a Malaysian Umrah travel agency.`,
    DOMAIN_ISOLATION_INSTRUCTION,
    suppression,
    intentAnchorInstruction(
      lastCustomer?.body,
      redactSuppressedTopics(lastCustomer?.body, suppressedTopics),
    ),
    conversionSignalInstruction(redactSuppressedTopics(lastCustomer?.body, suppressedTopics)),
    // AI QUOTATION EXECUTIVE™ — deterministic missing-input request.
    missingQuotationInputInstruction({
      packageInterest: (ctx.lead as Record<string, unknown> | null)?.["package_interest"] as
        | string
        | null,
      pax: (ctx.lead as Record<string, unknown> | null)?.["pax"] as number | null,
      latestMessage: redactSuppressedTopics(lastCustomer?.body, suppressedTopics),
    }),
    // CONVERSATIONAL VALIDATION GUARD — understand first, confirm only when needed.
    continuityInstruction(continuity),


    conversationIntelligenceInstruction(intel),
    // STEP 3I.1 — AI SALES ELITE™ (state, single next best action, closing mode).
    eliteSalesInstruction(buildEliteIntelligence(ctx, intel)),
    agencyIdentityInstruction(aiName),
    ISLAMIC_ELITE_PERSONA_AGENCY_INSTRUCTION,

    confidentPresenceInstruction(
      buildConfidenceRead({
        customerMessages: ctx.messages
          .filter((m) => m.sender === "customer")
          .map((m) => m.body),
      }),
    ),
    socialPresenceInstruction(
      buildSocialProfile({
        messages: ctx.messages.map((m) => ({ sender: m.sender, body: m.body })),
        knownName: (ctx.lead as Record<string, unknown> | null)?.["full_name"] as string | null,
        knownFacts: {
          name: (ctx.lead as Record<string, unknown> | null)?.["full_name"] as string | null,
          city: (ctx.lead as Record<string, unknown> | null)?.["city"] as string | null,
          pax: (ctx.lead as Record<string, unknown> | null)?.["pax"] as number | null,
          travel_month: (ctx.lead as Record<string, unknown> | null)?.["preferred_month"] as
            | string
            | null,
          budget_per_pax_myr: (ctx.lead as Record<string, unknown> | null)?.["budget_myr"] as
            | number
            | null,
          package_interest: (ctx.lead as Record<string, unknown> | null)?.["package_interest"] as
            | string
            | null,
        },
      }),
    ),
    `You speak with prospective pilgrims on WhatsApp. Personality: ${personality} Tone: ${tone}. Always respect Islamic etiquette.`,
    ...capabilityTruthInstructions({ voiceAvailable: true }),

    `${language} ${length} WhatsApp style, no markdown headings.`,
    s?.ai_emoji === false
      ? "Do not use emojis."
      : "You may use light, respectful emojis sparingly.",
    "Sales method: greet -> understand intent -> ask ONE or TWO qualifying questions at a time (travel month, number of pax, budget per person, hotel distance preference, first-time or repeat) -> recommend the best matching packages with price in RM -> handle objections -> propose next step (deposit / booking slot / call).",
    "QUOTATION RULE: once the customer has settled on one package AND confirmed how many pilgrims are travelling, call create_quotation with that package_id and pilgrim count, then send back the returned message_to_send exactly as written. NEVER calculate a total, discount, deposit or balance yourself, never promise a discount, and never state a figure that did not come from create_quotation or recommend_packages.",
    "After a quotation is issued: answer questions about it, handle objections, and propose the deposit as the next step. Deposit payment and booking confirmation are always completed by a human colleague — never claim a payment was received or a booking is confirmed.",
    useKb
      ? "MANDATORY: before answering ANY question about the agency, packages, prices, visas, hotels, flights, refunds, itineraries or policies, first call search_knowledge and base your answer on what it returns."
      : "Use search_knowledge when the customer asks something the package catalogue cannot answer.",
    s?.kb_strict_mode === false
      ? "You may add general Umrah guidance beyond the knowledge base, but never invent agency-specific facts, prices or dates."
      : "STRICT MODE: state agency facts only when they appear in the agency knowledge base or package catalogue. Never improvise. This restriction applies to AGENCY facts only — questions about UMRAIO® itself are always answerable from global UMRAIO knowledge.",
    "KNOWLEDGE PRIORITY (in order): 1) verified agency knowledge, 2) global UMRAIO knowledge, 3) the current conversation context, 4) safe general information, 5) ask a clarifying question, 6) human escalation as the last resort.",
    "search_knowledge returns two sources: `agency` results (this agency's verified data) and `global` results (official facts about the UMRAIO platform). Use agency results for agency-specific questions and global results for questions about UMRAIO itself.",
    "An empty agency knowledge base is NEVER a reason to go silent or escalate. If the customer asks what UMRAIO is or what it can do, answer confidently from global UMRAIO knowledge.",
    s?.kb_escalate_when_unknown === false
      ? "If nothing relevant is found, answer generally and invite the customer to ask for details."
      : "If nothing relevant is found for an AGENCY-specific question (price, date, hotel, Mutawwif, availability), do not fabricate: say you need to confirm the official agency information, and keep the conversation moving by asking for their preferred travel date and number of pilgrims.",
    "Always use the recommend_packages tool before quoting any package, and never invent packages, prices or departure dates.",
    "PRICE TRUTH: the ONLY authoritative prices are those returned by recommend_packages or create_quotation in THIS conversation. A price seen in a poster, image, PDF or knowledge-base document is NOT authoritative — if it differs from the catalogue, quote the catalogue figure and say the printed one needs confirming. Never round, discount, convert or estimate a price, and never state a per-person or total figure a tool did not return.",
    "Whenever the customer reveals their name, phone, budget, pax count or travel month, call update_lead_profile to save it.",
    "When the customer is not ready yet, call schedule_followup to book a polite follow-up.",
    "Qualification checklist you must complete naturally over the conversation (never as a form, one or two questions at a time): name, phone, city, number of pilgrims (pax), preferred travel month, budget per person and package interest. Save each detail with update_lead_profile as soon as you learn it.",
    "ESCALATION RULES: call escalate_to_human only when a human is genuinely needed. Set human_takeover=true ONLY when the customer EXPLICITLY asks to speak to a person ('nak bercakap dengan manusia/staff/agent', 'sambungkan saya dengan staf', 'saya nak orang sebenar') — that pauses the AI. Booking intent ('saya serius nak booking', 'apa langkah seterusnya', 'nak daftar', 'nak proceed', 'nak ambil pakej ni') is SALES INTENT, never a takeover: use human_takeover=false so staff are flagged while you keep selling. Never stop replying to the customer.",
    "A knowledge gap, a missing package, missing Mutawwif info, booking verification (availability, deposit, terms, pricing) or any missing agency data is NEVER a takeover. Keep AI enabled, answer what is verified, and ask a useful clarifying question.",
    "TRUTHFULNESS — NO FALSE ACTION CLAIMS (highest priority). You may NEVER claim that anything happened outside this chat unless a tool call in THIS conversation returned a persisted record proving it. Forbidden unless proven: 'saya sudah hantar kepada staf', 'staf sedang semak', 'staf akan hubungi tuan/puan', 'saya sudah buat booking', 'saya sudah reserve tempat', 'saya sudah semak dengan agensi', 'saya sudah minta pihak agensi mengesahkan'. Never invent a staff reply, availability, seat, deposit, flight, hotel, Mutawwif or price.",
    "If no handoff has actually been executed, say truthfully: 'Saya boleh tandakan permintaan ini untuk pengesahan pihak agensi. Buat masa ini saya belum boleh mengesahkan kekosongan, deposit, terma atau Mutawwif tanpa pengesahan rasmi.'",
    "To really notify the team, call request_human_handoff. Only after it returns handoff_recorded=true (with a reference and timestamp) may you tell the customer that the request has been sent to the agency team. Never promise a response time the tool did not give you.",
    "BOOKING ASSIST MODE: when the customer shows real purchase intent ('nak booking', 'nak daftar', 'macam mana nak tempah', 'nak proceed', 'boleh book?'), (1) confirm the package/date if known from recommend_packages, (2) confirm number of pilgrims, (3) identify missing critical info (nama penuh, no. telefon, bandar, bulan, bajet, bilangan jemaah), (4) use only verified agency/package data, (5) never invent availability, deposit, flights, hotels, Mutawwif or pricing, (6) if verified data exists explain the next step clearly, (7) if verification is needed call request_human_handoff and say truthfully what was recorded, (8) never request payment or bank details before verified official booking instructions exist, (9) keep momentum — end with a question or a concrete next step, never abruptly.",
    "Every customer message must receive a reply: an answer, a clarifying question, a safe fallback, or an explicit human-handoff message. Silence is never acceptable.",
    "Never promise visas, guarantees or refunds outside the listed inclusions.",

    // Islamic Implementation Layer™ — standing boundaries (always active)
    "ISLAMIC IMPLEMENTATION LAYER™ (standing rules): you are a travel-sales assistant, not a mufti, scholar, fatwa body or Shariah authority. Never issue religious rulings and never declare something definitively halal, haram, wajib, sunat, makruh, sah or batal.",
    "Never claim halal certification, JAKIM certification or Shariah compliance for the agency or any package. Never use absolute religious guarantees such as '100% halal', 'dijamin mabrur' or 'fully Shariah compliant'.",
    "recommend_packages returns halal_review_status for every package. Only a package with status REVIEWED has been reviewed by the agency; anything else must never be presented as religiously verified — unknown means review pending, not halal and not haram.",
    "RISK-BASED ISLAMIC ROUTING: established basic Islamic knowledge (Rukun Islam, Rukun Iman, meaning of Talbiyah/ihram/tawaf/sa'i, common doa, masjid etiquette, Umrah preparation) must be ANSWERED DIRECTLY from approved knowledge — never routed to a reviewer and never left pending. Only genuine ruling requests (hukum, fatwa, halal/haram determination, validity of someone's own worship, dam/fidyah, family or inheritance law) trigger request_expert_review, once, with one concise holding response. Never repeat that holding message on later messages, and never let a previous religious question block normal sales, pricing or logistics replies.",
    religiousBoundary,

    businessHoursLine(s),

    s?.ai_custom_instructions?.trim()
      ? `Agency custom instructions (highest priority, never break platform safety rules):\n${s.ai_custom_instructions.trim()}`
      : null,
    ctx.knowledge.length
      ? `Agency knowledge base index (use search_knowledge to read the full text):\n${ctx.knowledge
          .map((a) => `- [${a.category}] ${a.title}${a.summary ? ` — ${a.summary}` : ""}`)
          .join("\n")}`
      : "The agency knowledge base is empty. You can still answer questions about UMRAIO itself from global UMRAIO knowledge, and you can still qualify the lead. Only agency-specific facts need confirmation from the agency.",
    `Global UMRAIO knowledge index (platform facts, always available via search_knowledge):\n${GLOBAL_UMRAIO_KNOWLEDGE.map((a) => `- ${a.title} — ${a.summary}`).join("\n")}`,

    ctx.lead
      ? `Known lead profile: ${JSON.stringify(ctx.lead)}`
      : "No lead profile linked yet to this conversation.",
  ]
    .filter(Boolean)
    .join("\n");
}

export type LeadSignals = {
  full_name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  budget_myr?: number | string | null;
  pax?: number | null;
  preferred_month?: string | null;
  package_interest?: string | null;
  stage?: string | null;
};

/** Deterministic 0-100 qualification score from captured signals. */
export function computeLeadScore(lead: LeadSignals): number {
  let score = 10;
  if (lead.full_name && lead.full_name.trim().length > 2) score += 10;
  if (lead.phone) score += 10;
  if (lead.city) score += 8;
  if (lead.pax && Number(lead.pax) > 0) score += 12;
  if (lead.preferred_month) score += 15;
  if (lead.budget_myr && Number(lead.budget_myr) > 0) score += 20;
  if (lead.package_interest) score += 15;
  if (lead.stage === "proposal") score += 5;
  if (lead.stage === "booked") score = 100;
  return Math.max(0, Math.min(100, score));
}

export function temperatureForScore(score: number): "hot" | "warm" | "cold" {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

/**
 * Deterministic guard: only an EXPLICIT request to speak with a person may pause
 * the AI. Booking intent, knowledge gaps and verification needs must never do so.
 */
const EXPLICIT_HUMAN_PATTERNS: RegExp[] = [
  /\b(cakap|bercakap|bincang|berbual|contact|hubungi|sambung(kan)?|talk|speak|chat)\b[^.?!]{0,40}\b(manusia|human|staff|staf|agent|ejen|orang(\s+sebenar)?|person|admin|pegawai|manager|pengurus|customer service|cs)\b/i,
  /\b(staff|staf|agent|ejen|admin|manusia|human|orang)\b[^.?!]{0,30}\b(call|telefon|hubungi|whatsapp|contact)\b[^.?!]{0,20}\b(saya|aku|me|i)\b/i,
  /\b(real|live)\s+(person|agent|human)\b/i,
  /\bnak\s+(cakap|bercakap)\s+dengan\b/i,
  /\btransfer\s+(me\s+)?to\s+(a\s+)?(human|agent|staff|person)\b/i,
];

export function isExplicitHumanRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  return EXPLICIT_HUMAN_PATTERNS.some((re) => re.test(text));
}

function customerAskedForHuman(ctx: Awaited<ReturnType<typeof loadContext>>): boolean {
  const recentCustomer = ctx.messages
    .filter((m) => m.sender === "customer")
    .slice(-3)
    .map((m) => m.body);
  return recentCustomer.some(isExplicitHumanRequest);
}

type SalesCtx = Awaited<ReturnType<typeof loadContext>>;

/**
 * Sales AI tool definitions.
 *
 * These are registry definitions — never native SDK tools. Exposure to the
 * model always happens through `createSdkTools()`, so every call passes the
 * decision gate: allowedTools → schema → permission → business rule →
 * execution → audit.
 */
function buildSalesToolRegistry(ctx: SalesCtx, intel: ConversationIntelligence = buildIntelligence(ctx)): ToolRegistry {
  const leadId = ctx.conversation.lead_id as string | null;
  const leadFacts = {
    fullName: (ctx.lead as any)?.full_name ?? null,
    phone: (ctx.lead as any)?.phone ?? null,
    city: (ctx.lead as any)?.city ?? null,
    pax: (ctx.lead as any)?.pax ?? null,
    preferredMonth: (ctx.lead as any)?.preferred_month ?? null,
    budgetMyr: (ctx.lead as any)?.budget_myr ?? null,
    packageInterest: (ctx.lead as any)?.package_interest ?? null,
    stage: (ctx.lead as any)?.stage ?? null,
  };
  const quotationFacts = ctx.quotation
    ? {
        status: String((ctx.quotation as any).status),
        quotationNumber: (ctx.quotation as any).quotation_number ?? null,
        total: Number((ctx.quotation as any).total ?? 0),
        depositAmount:
          (ctx.quotation as any).deposit_amount === null
            ? null
            : Number((ctx.quotation as any).deposit_amount),
      }
    : null;
  const handoffBrief = (reason: string) =>
    buildHandoffBrief({ intel, lead: leadFacts, quotation: quotationFacts, reason });

  const tools: ToolDefinition[] = [
    {
      name: "search_knowledge",
      description:
        "Search knowledge. Returns `agency` results (this agency's verified FAQ, travel guide, package/visa/hotel info, uploaded PDFs) and `global` results (official facts about the UMRAIO platform itself). Call this before answering any factual question.",
      permission: "read",
      deterministicSafe: true,
      inputSchema: z.object({
        query: z.string(),
        category: z
          .enum(["faq", "travel_guide", "package_info", "visa_info", "hotel_info", "general"])
          .nullable(),
      }),
      execute: async ({ query, category }, tctx) => {
        const limit = ctx.settings?.kb_max_articles ?? 4;
        const agencyResults = searchKnowledge(ctx.knowledge, query, category, limit);
        const globalResults = searchGlobalKnowledge(query, limit);
        await tctx.supabase.from("activity_log").insert({
          agency_id: tctx.agencyId,
          actor: "ai",
          action: "AI knowledge lookup",
          entity: "conversation",
          entity_id: ctx.conversation.id,
          meta: {
            knowledge_source: agencyResults.length
              ? "agency"
              : globalResults.length
                ? "global"
                : "none",
            agency_hits: agencyResults.length,
            global_hits: globalResults.length,
          },
        });
        return {
          agency: agencyResults,
          global: globalResults,
          note: agencyResults.length
            ? undefined
            : "No agency-specific knowledge matched. Global UMRAIO knowledge may still answer questions about the platform. Do not fabricate agency facts.",
        };
      },
    },

    {
      name: "recommend_packages",
      description: "Look up the agency's active Umrah packages to recommend accurate options.",
      permission: "read",
      deterministicSafe: true,
      inputSchema: z.object({
        max_price_myr: z.number().nullable(),
        pax: z.number().nullable(),
        preferred_month: z.string().nullable(),
      }),
      execute: async ({ max_price_myr }) => {
        const list = ctx.packages as Array<Record<string, unknown>>;
        // Deterministic filtering stays in application code.
        const filtered = max_price_myr
          ? list.filter((p) => Number(p["price_myr"]) <= max_price_myr * 1.15)
          : list;
        return { packages: (filtered.length ? filtered : list).slice(0, 6) };
      },
    },

    {
      name: "update_lead_profile",
      description:
        "Save qualification details collected during the conversation onto the CRM lead (name, phone, city, pax, preferred month, budget, package interest).",
      permission: "write",
      deterministicSafe: true,
      inputSchema: z.object({
        full_name: z.string().nullable(),
        phone: z.string().nullable(),
        email: z.string().nullable(),
        city: z.string().nullable(),
        budget_myr: z.number().nullable(),
        pax: z.number().nullable(),
        preferred_month: z.string().nullable(),
        package_interest: z.string().nullable(),
        temperature: z.enum(["hot", "warm", "cold"]).nullable(),
        stage: z.enum(["new", "contacted", "qualified", "proposal", "booked", "lost"]).nullable(),
        preferred_language: z
          .enum(["auto", "ms", "en", "mix", "id", "ar", "zh", "ta", "ur", "bn"])
          .nullable()
          .describe("Set only when the customer explicitly states a language preference."),
      }),
      validate: (input) => {
        if (!leadId) return "No lead linked to this conversation.";
        if (input.pax !== null && (input.pax < 1 || input.pax > 200)) return "pax out of range.";
        if (input.budget_myr !== null && input.budget_myr < 0)
          return "budget_myr must be positive.";
        return null;
      },
      execute: async (input, tctx) => {
        const patch: Record<string, unknown> = { last_contact_at: new Date().toISOString() };
        for (const [k, v] of Object.entries(input)) if (v !== null && v !== "") patch[k] = v;

        const merged = { ...(ctx.lead ?? {}), ...patch } as LeadSignals;
        // Deterministic scoring — never delegated to the model.
        const score = computeLeadScore(merged);
        patch["score"] = score;
        if (!patch["temperature"]) patch["temperature"] = temperatureForScore(score);
        if (!patch["stage"] && (merged.pax || merged.budget_myr || merged.preferred_month)) {
          patch["stage"] = "qualified";
        }

        const previousStage = ((ctx.lead as Record<string, unknown> | null)?.["stage"] ??
          null) as string | null;
        const previousPackage = ((ctx.lead as Record<string, unknown> | null)?.[
          "package_interest"
        ] ?? null) as string | null;

        const { error } = await tctx.supabase.from("leads").update(patch).eq("id", leadId);
        if (error) return { saved: false, reason: error.message };

        // B-2 — authoritative funnel telemetry from the real state change only.
        const { recordLeadStageTransition, recordPackageInterest } = await import(
          "@/lib/conversion/producers"
        );
        await recordLeadStageTransition({
          db: tctx.supabase,
          agencyId: tctx.agencyId,
          leadId,
          from: previousStage,
          to: (patch["stage"] as string | undefined) ?? previousStage,
          actor: "ai",
        });
        await recordPackageInterest({
          db: tctx.supabase,
          agencyId: tctx.agencyId,
          leadId,
          packageName: (patch["package_interest"] as string | undefined) ?? null,
          previousPackageName: previousPackage,
          actor: "ai",
        });
        await tctx.supabase.from("activity_log").insert({
          agency_id: tctx.agencyId,
          actor: "ai",
          action: `AI WhatsApp Executive qualified lead (score ${score}, ${patch["temperature"]})`,
          entity: "lead",
          entity_id: leadId,
          meta: patch,
        });
        return {
          saved: true,
          score,
          temperature: patch["temperature"],
          fields: Object.keys(patch),
        };
      },
    },

    {
      name: "create_quotation",
      description:
        "Issue a formal written quotation for ONE of the agency's active packages once the customer has confirmed the package and the number of pilgrims. You choose the package and the pilgrim count only — every price, discount, deposit and total is calculated by the system. Returns the exact quotation text to send to the customer.",
      permission: "write",
      deterministicSafe: true,
      islamicScope: "TRANSACTION",
      islamicPayload: (input: { notes?: string | null }) => input.notes ?? "",
      inputSchema: z.object({
        package_id: z.string(),
        pilgrims: z.number().int().min(1).max(50),
        travel_month: z.string().nullable(),
        notes: z.string().max(400).nullable(),
      }),
      validate: async (input, tctx) => {
        if (!leadId) return "No lead linked to this conversation; qualify the customer first.";
        const { data: pkg } = await tctx.supabase
          .from("packages")
          .select("id, is_active")
          .eq("id", input.package_id)
          .eq("agency_id", tctx.agencyId)
          .maybeSingle();
        if (!pkg) return "That package does not belong to this agency.";
        if (pkg.is_active === false) return "That package is no longer active.";
        // One live quotation at a time per lead keeps pricing unambiguous.
        const { count } = await tctx.supabase
          .from("quotations")
          .select("id", { count: "exact", head: true })
          .eq("lead_id", leadId)
          .in("status", ["ready", "sent", "viewed", "discussing"]);
        if ((count ?? 0) > 0) {
          return "This lead already has a live quotation. Discuss the existing quotation instead of issuing a new one.";
        }
        return null;
      },
      execute: async (input, tctx) => {
        const { createQuotation, renderQuotationMessage, quotationLink } =
          await import("./quotations/quotations.server");
        const lead = ctx.lead as Record<string, unknown> | null;
        const row = await createQuotation(tctx.supabase, tctx.agencyId, {
          packageId: input.package_id,
          pilgrims: input.pilgrims,
          leadId,
          conversationId: ctx.conversation.id as string,
          travelMonth: input.travel_month ?? (lead?.["preferred_month"] as string | null) ?? null,
          customerName: (lead?.["full_name"] as string | null) ?? null,
          customerPhone: (lead?.["phone"] as string | null) ?? null,
          notes: input.notes ?? null,
          // Discounts are a human commercial decision — never a model one.
        });
        const agencyName = (ctx.agency as { name?: string } | null)?.name ?? "our agency";
        return {
          created: true,
          quotation_number: row.quotation_number,
          total_myr: Number(row.total),
          deposit_myr: row.deposit_amount === null ? null : Number(row.deposit_amount),
          customer_link: quotationLink(row.public_token),
          message_to_send: renderQuotationMessage(row, agencyName),
          instruction:
            "Send message_to_send to the customer as-is (you may add a short greeting). Never change any figure.",
        };
      },
    },

    {
      name: "schedule_followup",
      description: "Schedule a follow-up task for this prospect.",
      permission: "write",
      deterministicSafe: true,
      inputSchema: z.object({
        title: z.string(),
        hours_from_now: z.number(),
      }),
      validate: (input) => (input.title.trim() ? null : "A follow-up title is required."),
      execute: async ({ title, hours_from_now }, tctx) => {
        const runAt = new Date(Date.now() + Math.max(1, hours_from_now) * 3600_000);
        const { error } = await tctx.supabase.from("followup_jobs").insert({
          agency_id: tctx.agencyId,
          lead_id: leadId,
          title,
          channel: "whatsapp",
          run_at: runAt.toISOString(),
          status: "pending",
        });
        if (error) return { scheduled: false, reason: error.message };
        await tctx.supabase.from("activity_log").insert({
          agency_id: tctx.agencyId,
          actor: "ai",
          action: `Scheduled follow-up: ${title}`,
          entity: "lead",
          entity_id: leadId,
          meta: { run_at: runAt.toISOString(), channel: "whatsapp" },
        });
        return { scheduled: true, run_at: runAt.toISOString() };
      },
    },

    {
      name: "escalate_to_human",
      description:
        "Flag that a human colleague should look at this conversation. Set human_takeover=true ONLY when the customer explicitly asked to speak with a person — that pauses the AI. Booking intent, knowledge gaps and verification needs use human_takeover=false: the team is notified but you keep helping the customer.",
      permission: "write",
      deterministicSafe: true,
      inputSchema: z.object({
        reason: z.string(),
        urgency: z.enum(["low", "normal", "high"]),
        human_takeover: z
          .boolean()
          .describe("true only for an explicit human takeover or a sensitive transaction"),
      }),
      validate: (input) => (input.reason.trim() ? null : "An escalation reason is required."),
      execute: async ({ reason, urgency, human_takeover }, tctx) => {
        const now = new Date().toISOString();
        // Deterministic guard: the model may only pause the AI when the customer
        // explicitly asked for a person. Booking intent / verification never pauses it.
        const requested = customerAskedForHuman(ctx);
        const takeover = human_takeover && requested;
        const patch: Record<string, unknown> = {
          status: "open",
          escalated_at: now,
          escalation_reason: reason,
          human_attention_required: true,
        };
        // Non-destructive by default: knowledge gaps and booking intent never silence the AI.
        if (takeover) patch["ai_enabled"] = false;
        await tctx.supabase.from("conversations").update(patch).eq("id", ctx.conversation.id);
        await tctx.supabase.from("followup_jobs").insert({
          agency_id: tctx.agencyId,
          lead_id: leadId,
          title: takeover
            ? `Human takeover needed: ${reason}`
            : `Human attention requested: ${reason}`,
          context: { handoff_brief: handoffBrief(reason), conversation_state: intel.state },
          channel: "whatsapp",
          run_at: new Date(Date.now() + (urgency === "high" ? 15 : 60) * 60_000).toISOString(),
          status: "pending",
        });
        await tctx.supabase.from("activity_log").insert({
          agency_id: tctx.agencyId,
          actor: "ai",
          action: takeover
            ? `Human takeover activated on WhatsApp conversation (${urgency})`
            : `Human attention requested on WhatsApp conversation (${urgency})`,
          entity: "conversation",
          entity_id: ctx.conversation.id,
          meta: {
            reason,
            urgency,
            human_takeover: takeover,
            requested_takeover: human_takeover,
            explicit_human_request: requested,
            ai_remains_enabled: !takeover,
            decision: takeover ? "human_takeover" : "human_attention_required",
            handoff_brief: handoffBrief(reason),
            conversation_state: intel.state,
          },
        });
        return {
          escalated: true,
          human_takeover: takeover,
          ai_still_enabled: !takeover,
          downgraded: human_takeover && !takeover,
          instruction: takeover
            ? "Tell the customer politely that a human colleague will continue shortly, then stop."
            : "AI stays active. A colleague has been notified. Keep helping the customer normally: say truthfully that final booking details (availability, deposit, terms) need agency confirmation, and continue qualifying (preferred month, number of pilgrims, budget).",
        };
      },
    },

    {
      name: "request_human_handoff",
      description:
        "Really send a verification/booking request to the agency team. Persists a notification, a follow-up task and an activity record. Only after this returns handoff_recorded=true may you tell the customer that the request has been sent. Never claim a handoff without calling this.",
      permission: "external",
      deterministicSafe: true,
      inputSchema: z.object({
        request: z.string().describe("What the team must verify or action, in one sentence"),
        topic: z.enum([
          "availability",
          "pricing",
          "deposit",
          "mutawwif",
          "booking",
          "documents",
          "other",
        ]),
        urgency: z.enum(["low", "normal", "high"]),
      }),
      validate: (input) =>
        input.request.trim() ? null : "A concrete request description is required.",
      execute: async ({ request, topic, urgency }, tctx) => {
        const now = new Date();
        const reference = `HO-${now.getTime().toString(36).toUpperCase()}`;
        const { error: notifyError } = await tctx.supabase.from("notifications").insert({
          agency_id: tctx.agencyId,
          kind: "human_handoff",
          severity: urgency === "high" ? "warning" : "info",
          title: `Customer request needs agency verification (${topic})`,
          body: `${request}\n\n${handoffBrief(request)}`,
          entity: "conversation",
          entity_id: ctx.conversation.id,
          meta: { reference, topic, urgency, lead_id: leadId },
        });
        if (notifyError) {
          return {
            handoff_recorded: false,
            reason: notifyError.message,
            instruction:
              "The handoff was NOT recorded. Do not tell the customer that anything was sent. Say truthfully that you cannot confirm agency-specific details yet, and continue helping.",
          };
        }
        await tctx.supabase.from("followup_jobs").insert({
          agency_id: tctx.agencyId,
          lead_id: leadId,
          title: `[${reference}] ${topic}: ${request}`,
          channel: "whatsapp",
          run_at: new Date(now.getTime() + (urgency === "high" ? 15 : 60) * 60_000).toISOString(),
          status: "pending",
        });
        await tctx.supabase
          .from("conversations")
          .update({ human_attention_required: true })
          .eq("id", ctx.conversation.id);
        await tctx.supabase.from("activity_log").insert({
          agency_id: tctx.agencyId,
          actor: "ai",
          action: `Handoff request sent to agency team (${topic})`,
          entity: "conversation",
          entity_id: ctx.conversation.id,
          meta: {
            reference,
            topic,
            urgency,
            request,
            conversation_id: ctx.conversation.id,
            destination: "agency team inbox",
            recorded_at: now.toISOString(),
          },
        });
        return {
          handoff_recorded: true,
          reference,
          recorded_at: now.toISOString(),
          destination: "agency team inbox",
          ai_still_enabled: true,
          instruction:
            "You may now truthfully tell the customer the request was forwarded to the agency team for confirmation (mention the reference if useful). Do not invent a staff reply or a response time. Continue qualifying the lead.",
        };
      },
    },

    {
      name: "request_expert_review",
      description:
        "Islamic Implementation Layer™ ESCALATION ONLY: route a HIGH-RISK or genuinely case-specific religious question to a qualified human expert, together with your AI-generated draft answer. Use it ONLY for fatwa requests, serious halal/haram determinations, personal validity questions, dam/fidyah/kafarah cases, talaq, faraid and Islamic financial/legal rulings. NEVER use it for established educational knowledge or ordinary guidance — answer those yourself. Only after it returns review_recorded=true may you tell the customer that a qualified person has been asked to review.",
      permission: "external",
      deterministicSafe: true,
      inputSchema: z.object({
        question: z.string().describe("The customer's religious question, in one sentence"),
        topic: z.enum(["ritual", "halal_status", "financial", "mahram", "other"]),
        draft_answer: z
          .string()
          .optional()
          .describe(
            "Your best structured draft answer for the human expert to approve, amend or reject. Never sent to the customer unapproved.",
          ),
        sources: z
          .string()
          .optional()
          .describe("Approved knowledge sources you relied on for the draft, comma separated."),
        escalation_reason: z
          .string()
          .optional()
          .describe("One short sentence explaining why this needs a qualified human expert."),
      }),
      validate: (input) =>
        input.question.trim() ? null : "A concrete question is required for expert review.",
      execute: async ({ question, topic, draft_answer, sources, escalation_reason }, tctx) => {
        // V2.4 — server-authoritative risk gate. BASIC / GUIDANCE questions
        // never open a review, even if the model asks for one. SENSITIVE may
        // escalate only when the model judges individual judgement is needed.
        const risk = classifyIslamicRisk(question);
        console.log(
          `[islamic] ISLAMIC_RISK_CLASSIFICATION stage=request_expert_review classification=${risk.tier ?? "NONE"} reason=${risk.reason} conversation_id=${ctx.conversation.id}`,
        );
        if (!mayEscalateIslamicReview(risk.tier)) {
          return {
            review_recorded: false,
            classification: risk.tier ?? "NONE",
            instruction:
              "No review was opened: this is established basic or ordinary Islamic knowledge, not a high-risk ruling request. Answer the customer NOW from approved knowledge, adding a short 'secara umum' qualification if useful, without issuing a personal ruling and without telling the customer that anyone is reviewing it.",
          };
        }
        // ISLAMIC IMPLEMENTATION LAYER™ — dedicated review domain.
        // Never an ai_tasks row, never the sales approval queue.
        const { createOrReuseIslamicReview } = await import("./islamic/review.server");

        const outcome = await createOrReuseIslamicReview(tctx.supabase, {
          agencyId: tctx.agencyId,
          conversationId: ctx.conversation.id,
          leadId,
          question,
          topic,
          riskLevel: risk.tier ?? "HIGH_RISK",
          escalationReason: escalation_reason ?? risk.reason,
          draftAnswer: draft_answer ?? null,
          sources: sources ?? null,
        });

        if (!outcome.recorded) {
          return {
            review_recorded: false,
            instruction:
              "The review request was NOT recorded. Do not claim anyone was notified. Say truthfully that you are not a religious authority and cannot give a ruling, then continue helping with travel arrangements.",
          };
        }
        await tctx.supabase
          .from("conversations")
          .update({ human_attention_required: true })
          .eq("id", ctx.conversation.id);
        return {
          review_recorded: true,
          review_id: outcome.reviewId,
          reference: outcome.reference,
          duplicate_suppressed: outcome.deduplicated,
          review_status: "PENDING",
          ai_still_enabled: true,
          instruction:
            "Tell the customer ONCE, briefly, that you are not a religious authority and the question is now with a qualified reviewer. Do NOT ask the customer to reconfirm or restate the question. Do not give a ruling yourself. Continue helping with the travel side of the enquiry.",
        };

      },
    },
  ];

  return createToolRegistry(tools);
}

/**
 * LATENCY — read-only warm-up. Loads exactly the same inputs the reply path
 * needs (context + quota) so they can be fetched CONCURRENTLY with the
 * coalescing wait instead of serially after it. Never decides anything: the
 * result is only reused when the conversation content is provably unchanged.
 */
export type PrefetchedReplyInputs = {
  ctx: Awaited<ReturnType<typeof loadContext>>;
  quota: Awaited<ReturnType<typeof assertQuota>>;
  latestMessageAt: string | null;
};

export function latestMessageStamp(
  messages: ReadonlyArray<{ created_at?: string | null }>,
): string | null {
  let latest: string | null = null;
  for (const m of messages) {
    const at = m.created_at ?? null;
    if (at && (!latest || at > latest)) latest = at;
  }
  return latest;
}

export async function prefetchReplyInputs(
  supabase: Db,
  conversationId: string,
): Promise<PrefetchedReplyInputs | null> {
  try {
    const ctx = await loadContext(supabase, conversationId);
    const agencyId = ctx.conversation.agency_id as string;
    const quota = await assertQuota(supabase, agencyId, "customer_reply");
    return {
      ctx,
      quota,
      latestMessageAt: latestMessageStamp(
        ctx.messages as ReadonlyArray<{ created_at?: string | null }>,
      ),
    };
  } catch {
    // Fail soft: the caller falls back to the normal sequential path.
    return null;
  }
}

export async function generateAgentReply(
  supabase: Db,
  conversationId: string,
  warm?: { prefetched: PrefetchedReplyInputs | null; expectedLatestMessageAt: string | null },
): Promise<string> {
  const turnStartedAt = new Date().toISOString();
  // Reuse the warm read ONLY when no new message landed during the wait.
  const reusable =
    warm?.prefetched &&
    warm.prefetched.ctx.conversation.id === conversationId &&
    warm.prefetched.latestMessageAt === warm.expectedLatestMessageAt
      ? warm.prefetched
      : null;

  const ctx = reusable ? reusable.ctx : await loadContext(supabase, conversationId);
  const agencyId = ctx.conversation.agency_id as string;


  // Step 3.6 — DETERMINISTIC SAFETY GATE. Customer control (opt-out, explicit
  // human request) is decided in code and short-circuits the model entirely.
  const intel = buildIntelligence(ctx);
  const gate = await applySafetyGate({
    supabase,
    agencyId,
    conversationId: ctx.conversation.id as string,
    leadId: (ctx.conversation.lead_id as string | null) ?? null,
    intel,
  });
  if (gate.blocked) {
    // RELIABILITY: no silent terminal outcome. The model is skipped, but the
    // customer still receives ONE closing acknowledgement (which is also the
    // compliant answer to an opt-out) instead of total silence.
    console.log("[sales-ai] outbound suppressed", {
      conversation: safeConversationRef(ctx.conversation.id as string),
      reason: gate.reason,
      terminal_outcome: "safety_gate_ack",
    });
    return gate.customerMessage ?? "";
  }


  // COMMERCIAL SAFETY — checked BEFORE any model call, from the server-side
  // plan only. Fails closed when metering is unavailable (never unlimited AI).
  const quota = reusable
    ? reusable.quota
    : await assertQuota(supabase, agencyId, "customer_reply");


  const rawHistory = ctx.messages.slice(-40).map((m) => ({
    role: (m.sender === "customer" ? "user" : "assistant") as "user" | "assistant",
    content: m.sender === "human" ? `[Human agent]: ${m.body}` : m.body,
  }));
  // Context sanitization: strip explicitly suppressed topics from the model's
  // context window while preserving all Umrah business context.
  const suppressedTopics = collectContextSuppression(ctx);
  const history = sanitizeHistory(rawHistory, suppressedTopics);

  // Safe diagnostics only (no message bodies, no prompts, no secrets).
  console.log("[sales-ai] context", {
    build: BUILD_REVISION,
    conversation: safeConversationRef(ctx.conversation.id as string),
    loaded_messages: ctx.messages.length,
    model_history_before: rawHistory.length,
    model_history_after: history.length,
    suppression_detected: suppressedTopics.length > 0,
    suppressed_topic_count: suppressedTopics.length,
    suppressed_occurrences_after: countSuppressedOccurrences(
      history.map((h) => h.content),
      suppressedTopics,
    ),
  });

  // Tools are exposed to the model ONLY through the registry adapter, so every
  // call runs the decision gate before it can touch the database.
  const registry = buildSalesToolRegistry(ctx, intel);
  const correlationId = newCorrelationId();
  const allowedTools = registry.names();
  const toolCtx: ToolExecutionContext = {
    supabase,
    agencyId,
    correlationId,
    grantedPermissions: ["read", "write", "external"],
    islamicPolicy: createIslamicPolicyChecker(supabase, agencyId),

    allowedTools,
  };

  // P0-4 — observe tool outcomes so an EMPTY completion can be explained
  // truthfully (e.g. create_quotation rejected because one is already live).
  const toolRecords: ToolRejectionRecord[] = [];
  const observedTools = Object.fromEntries(
    Object.entries(createSdkTools({ registry, ctx: toolCtx })).map(([name, definition]) => {
      const original = (definition as { execute?: (...args: any[]) => Promise<any> }).execute;
      if (!original) return [name, definition];
      return [
        name,
        {
          ...definition,
          execute: async (...args: any[]) => {
            const outcome = await original(...args);
            const o = outcome as { status?: string; reason?: string | null } | null;
            toolRecords.push({
              tool: name,
              status: o?.status ?? "unknown",
              reason: o?.reason ?? null,
            });
            return outcome;
          },
        },
      ];
    }),
  );


  // Idempotency: a retry for the SAME inbound customer message reuses this key,
  // so a duplicated/retried request can never be counted twice.
  const lastMessageId = ctx.messages.length
    ? (ctx.messages[ctx.messages.length - 1] as { id?: string }).id
    : undefined;
  const usageKey = `reply:${ctx.conversation.id}:${lastMessageId ?? correlationId}`;

  const gateway = createIntelligenceGateway({ supabase, agencyId });
  const result = await gateway.generate({
    taskType: "customer_reply",
    system: systemPrompt(ctx, suppressedTopics, intel),
    prompt: "",
    messages: history.length ? history : [{ role: "user", content: "Assalamualaikum" }],
    tools: observedTools,
    // Cost ceiling for customer-facing conversations (entitlement-aware).
    maxSteps: quota.plan.maxConversationSteps,
    context: {
      agencyId,
      correlationId,
      now: new Date().toISOString(),
      facts: {
        conversation_id: ctx.conversation.id,
        lead_linked: Boolean(ctx.conversation.lead_id),
        channel: ctx.conversation.channel,
      },
      allowedTools,
    },
  });

  await recordUsageEvent(supabase, {
    agencyId,
    eventKey: usageKey,
    category: "customer_reply",
    taskType: "customer_reply",
    operation: "generate_agent_reply",
    source: ctx.conversation.channel ?? "conversation",
    worker: "whatsapp",
    model: result.usage?.model ?? null,
    provider: result.usage?.provider ?? null,
    correlationId,
    success: result.ok,
    latencyMs: result.usage?.latencyMs ?? null,
    meta: { conversation_id: ctx.conversation.id },
  });

  if (!result.ok) {
    // P0-4 FINAL — a live-quotation rejection is NOT a provider failure. The model
    // produced zero text after the tool rejection, the gateway correctly surfaced
    // the empty run as !result.ok, but the customer still deserves the truthful,
    // deterministic existing-quotation reply instead of silence.
    if (isLiveQuotationRejection(toolRecords)) {
      const q = ctx.quotation as Record<string, unknown> | null;
      const reply = emptyCompletionReply({
        toolRecords,
        quotation: q
          ? {
              quotationNumber: (q["quotation_number"] as string | null) ?? null,
              status: (q["status"] as string | null) ?? null,
              totalMyr: q["total"] === null || q["total"] === undefined ? null : Number(q["total"]),
            }
          : null,
      });
      await recordExperience(supabase, agencyId, {
        interaction_id: correlationId,
        task_type: "customer_reply",
        model: result.usage?.model ?? null,
        input_context_hash: hashContext({ facts: { conversation_id: ctx.conversation.id } }),
        action_taken: "existing quotation explained",
        outcome: "empty_reply_fallback",
        success: true,
        confidence: null,
        evaluation_score: null,
        failure_reason: null,
      });
      return reply;
    }
    // Never fabricate a reply. The gateway already logged AI_FAILURE with the
    // correlation id; the caller keeps its existing failure/escalation path.
    await recordExperience(supabase, agencyId, {
      interaction_id: correlationId,
      task_type: "customer_reply",
      model: result.usage?.model ?? null,
      input_context_hash: hashContext({ facts: { conversation_id: ctx.conversation.id } }),
      action_taken: "no reply generated",
      outcome: "gateway_failure",
      success: false,
      confidence: null,
      evaluation_score: null,
      failure_reason: result.error?.message ?? "AI provider unavailable",
    });
    throw new Error(result.error?.message ?? "AI provider unavailable");
  }

  // CAPABILITY TRUTH — the model may never deny a capability the system has.
  // Enforced deterministically, not left to the prompt.
  const latestCustomerBody = [...ctx.messages].reverse().find((m) => m.sender === "customer")?.body;
  const text = sanitizeCapabilityClaims((result.data ?? "").trim(), {
    voiceAvailable: true,
    customerAskedIdentity: customerAskedAboutAiIdentity(latestCustomerBody),
    liveCallRequested: customerAskedForLiveCall(latestCustomerBody),
  });

  // Step 3 — persist derived conversation memory (real data only, no fabrication).
  try {
    const quality = conversationQualityScore({ messages: ctx.messages, intel });
    await supabase
      .from("conversations")
      .update({
        conversation_state: intel.state,
        state_updated_at: new Date().toISOString(),
        intelligence: {
          state: intel.state,
          confidence: intel.confidence,
          language: intel.language,
          language_source: intel.languageSource,
          style: intel.style,
          signals: intel.signals,
          objections: intel.objections,
          objection_memory: intel.objectionMemory,
          buying_signals: intel.buyingSignals,
          next_best_action: intel.nextBestAction,
          active_objections: intel.activeObjections,
          objection_lifecycle: intel.objectionLifecycle,
          traveller_needs: intel.travellerNeeds,
          budget: intel.budget,
          opt_out: intel.optOut,
          human_requested: intel.humanRequested,
          missing: intel.missing,
          behavior: {
            strategy: intel.behavior.strategy,
            trust: intel.behavior.trust,
            hesitation: intel.behavior.hesitation,
            price_sensitivity: intel.behavior.priceSensitivity,
            value_sensitivity: intel.behavior.valueSensitivity,
            value_dimensions: intel.behavior.valueDimensions,
            urgency: intel.behavior.urgency,
            decision_readiness: intel.behavior.decisionReadiness,
            information_load: intel.behavior.informationLoad,
            comparison: intel.behavior.comparison,
            decision_makers: intel.behavior.decisionMakers,
            decision_maker_dependency: intel.behavior.decisionMakerDependency,
            decision_maker_resolved: intel.behavior.decisionMakerResolved,
            reassurance_need: intel.behavior.reassuranceNeed,
            closing_readiness: intel.behavior.closingReadiness,
            communication_traits: intel.behavior.communicationTraits,
            rationale: intel.behavior.rationale,
          },
          quality_score: quality.score,
          quality_factors: quality.factors,

          updated_at: new Date().toISOString(),
        },
      })
      .eq("id", ctx.conversation.id);

    if (ctx.conversation.lead_id && intel.language !== "auto") {
      await supabase
        .from("leads")
        .update({
          detected_language: intel.language,
          language_confidence: intel.languageConfidence,
          conversational_style: intel.style,
          ...(intel.travellerNeeds.length ? { traveller_needs: intel.travellerNeeds } : {}),
          ...(intel.budget.totalBudgetMyr ? { total_budget_myr: intel.budget.totalBudgetMyr } : {}),
          ...(intel.budget.perPersonBudgetMyr || intel.budget.totalBudgetMyr
            ? { budget_basis: intel.budget.perPersonBudgetMyr ? "per_person" : "total" }
            : {}),
        })
        .eq("id", ctx.conversation.lead_id);
    }
  } catch (error) {
    console.warn("[sales-ai] intelligence persistence skipped", (error as Error).message);
  }

  await recordExperience(supabase, agencyId, {
    interaction_id: correlationId,
    task_type: "customer_reply",
    model: result.usage?.model ?? null,
    input_context_hash: hashContext({ facts: { conversation_id: ctx.conversation.id } }),
    action_taken: "customer reply generated",
    outcome: text ? "reply_returned" : "empty_reply_fallback",
    success: Boolean(text),
    confidence: null,
    evaluation_score: null,
    failure_reason: null,
  });

  // IIL V2.4 — DETERMINISTIC ESCALATION GUARANTEE. A HIGH_RISK turn always
  // opens exactly one expert review carrying the AI-generated draft, even when
  // the model neglected to call request_expert_review. BASIC / GUIDANCE /
  // SENSITIVE turns are never escalated here.
  try {
    const lastCustomerTurn = [...ctx.messages].reverse().find((m) => m.sender === "customer");
    const turnRisk = classifyIslamicRisk(lastCustomerTurn?.body);
    if (turnRisk.tier === "HIGH_RISK") {
      const { createOrReuseIslamicReview, findOpenReviewForConversation } = await import(
        "./islamic/review.server"
      );
      const existing = await findOpenReviewForConversation(supabase, ctx.conversation.id as string);
      const alreadyOpenedThisTurn = Boolean(existing && existing.created_at >= turnStartedAt);
      if (!alreadyOpenedThisTurn) {
        const outcome = await createOrReuseIslamicReview(supabase, {
          agencyId,
          conversationId: ctx.conversation.id as string,
          leadId: (ctx.conversation.lead_id as string | null) ?? null,
          question: (lastCustomerTurn?.body ?? "").slice(0, 2000),
          topic: "other",
          riskLevel: "HIGH_RISK",
          escalationReason: turnRisk.reason,
          draftAnswer: text || null,
        });
        console.log(
          `[islamic] ISLAMIC_ESCALATION_GUARANTEE recorded=${outcome.recorded} deduplicated=${outcome.deduplicated} reason=${turnRisk.reason}`,
        );
      }
    }
  } catch (error) {
    console.warn("[islamic] escalation guarantee skipped", (error as Error).message);
  }

  if (text) return text;

  // P0-4 — an empty completion on a normal turn is NEVER an ASR failure. Explain
  // a blocking tool rejection truthfully, otherwise hold neutrally.
  const q = ctx.quotation as Record<string, unknown> | null;
  return emptyCompletionReply({
    toolRecords,
    quotation: q
      ? {
          quotationNumber: (q["quotation_number"] as string | null) ?? null,
          status: (q["status"] as string | null) ?? null,
          totalMyr: q["total"] === null || q["total"] === undefined ? null : Number(q["total"]),
        }
      : null,
  });
}


export type ConversationInsights = {
  summary: string;
  customer_profile: string;
  qualification: string;
  objections: string;
  followup_message: string;
  booking_suggestion: string;
  next_step: string;
};

const insightsSchema = z.object({
  summary: z.string(),
  customer_profile: z.string(),
  qualification: z.string(),
  objections: z.string(),
  followup_message: z.string(),
  booking_suggestion: z.string(),
  next_step: z.string(),
});

export async function generateInsights(
  supabase: Db,
  conversationId: string,
): Promise<ConversationInsights> {
  const ctx = await loadContext(supabase, conversationId);
  const agencyId = ctx.conversation.agency_id as string;
  const transcript = ctx.messages
    .map((m) => `${m.sender === "customer" ? "Customer" : "Agency"}: ${m.body}`)
    .join("\n");

  const prompt = [
    "Analyse this Umrah sales conversation for the agency's sales team.",
    "Return short, factual Malaysian-English text for each field (max 2 sentences each).",
    "followup_message must be a ready-to-send WhatsApp follow-up in the customer's language.",
    "booking_suggestion must name the recommended package, pax, estimated total in RM and the deposit ask.",
    "",
    "Active packages:",
    JSON.stringify(ctx.packages),
    "",
    "Transcript:",
    transcript || "(no messages yet)",
  ].join("\n");

  const correlationId = newCorrelationId();
  const gateway = createIntelligenceGateway({ supabase, agencyId });
  const result = await gateway.extract<ConversationInsights>({
    taskType: "conversation_analysis",
    prompt,
    schema: insightsSchema,
    context: {
      agencyId,
      correlationId,
      now: new Date().toISOString(),
      facts: { conversation_id: ctx.conversation.id },
      allowedTools: [],
    },
  });

  // Internal reasoning: metered for cost visibility, but it is NOT a customer
  // reply and therefore consumes no AI reply quota.
  await recordUsageEvent(supabase, {
    agencyId,
    eventKey: `insights:${correlationId}`,
    category: "internal_operation",
    taskType: "conversation_analysis",
    operation: "generate_conversation_insights",
    model: result.usage?.model ?? null,
    provider: result.usage?.provider ?? null,
    correlationId,
    success: result.ok,
    latencyMs: result.usage?.latencyMs ?? null,
    meta: { conversation_id: ctx.conversation.id },
  });

  if (!result.ok || !result.data) {
    throw new Error(result.error?.message ?? "Could not generate insights. Please try again.");
  }
  return result.data;
}
