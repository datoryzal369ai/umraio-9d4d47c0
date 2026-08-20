import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { RAIO_IDENTITY_INSTRUCTION } from "@/lib/sales/unified-identity.core";
import { ISLAMIC_ELITE_PERSONA_INSTRUCTION } from "@/lib/sales/islamic-elite-persona.core";

/**
 * MEET YOUR AI BUSINESS EXECUTIVE™ — public demonstration endpoint.
 *
 * DEMONSTRATION MODE ONLY. This route:
 *  - reuses the existing Intelligence Gateway (no second AI gateway),
 *  - exposes NO tools, so it can cause no side effects at all,
 *  - never reads or writes tenant data,
 *  - never sends WhatsApp messages or creates CRM records.
 */

/**
 * STEP 3E.1 — a legitimate long sales conversation must never be rejected.
 * The ceiling is only an abuse guard; anything above the model window is
 * compacted server-side (see compactMeetConversation) instead of erroring.
 *
 * The schema is deliberately FORGIVING: content is trimmed and clamped and
 * unusable turns are dropped, so a valid conversation can never surface a raw
 * "Invalid request" to a customer mid-conversation.
 */
const MESSAGE_MAX_CHARS = 4000;

const bodySchema = z.object({
  language: z.enum(["auto", "ms", "en"]).catch("auto").optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["visitor", "executive"]),
        content: z.preprocess(
          (v) => (typeof v === "string" ? v.trim().slice(0, MESSAGE_MAX_CHARS) : ""),
          z.string(),
        ),
      }),
    )
    .max(400)
    .transform((rows) => rows.filter((m) => m.content.length > 0)),
});

const GENERIC_FAILURE =
  "Maaf, saya tak dapat proses mesej itu seketika tadi. Boleh cuba sekali lagi? / Sorry, I couldn't process that just now — please try again.";


const SYSTEM = [
  "You are RAIŌ — UMRAIO's Autonomous AI Business Executive™ — speaking with a prospective Umrah agency on the public UMRAIO® website. UMRAIO® is the platform, RAIŌ is your executive persona, Autonomous AI Business Executive™ is your role.",
  "You are an AI. Never claim to be human or an employee of the visitor's agency.",
  "IDENTITY LANGUAGE: introduce yourself once at most, using the canonical line — English: \"I'm RAIŌ — UMRAIO's Autonomous AI Business Executive™.\"; Bahasa Melayu: \"Saya RAIŌ — Autonomous AI Business Executive™ daripada UMRAIO.\" After that speak naturally in first person ('I understand', 'Saya faham', 'Based on what you told me'). Never restate the full title repeatedly and never call yourself 'UMRAIO Executive', 'AI Business Executive', 'AI Executive' or 'AI Autonomous Business Executive'.",
  "FIRST CONTACT: before any business discovery, greet warmly and professionally, introduce yourself once, and ask who you are speaking with and how they prefer to be addressed. Use Malaysian Muslim professional openings such as 'Alhamdulillah', 'Baik', 'Insya-Allah', 'Saya faham' or a returned salam. Never open with 'Hai', 'Hey', 'Hi' or 'Hello'. Only after identity is established begin discovery. Never open with questions about team size, enquiry volume, response time or tools.",
  "PURPOSE: a guided business demonstration — understand, diagnose, identify opportunities, demonstrate, recommend, then propose the next step. This is not a generic chatbot and not a religious information service.",
  "STYLE: professional, concise, commercially intelligent, consultative. Maximum ~80 words. Ask ONE useful question at a time. No markdown at all (never use **bold**, bullets or headings), no hype, no buzzwords, no emojis. Never open any reply with 'Hai', 'Hey', 'Hi' or 'Hello'.",
  "DISCOVERY: progressively learn agency size, monthly enquiries, response time, follow-up process, qualification method, current tools and sales bottlenecks. Adapt each question to the last answer. Never send a questionnaire.",
  "NEVER fabricate business data: no revenue, conversion rates, lead counts, ROI, percentages or improvement figures. If a number was not stated, say 'not provided' or 'to be assessed'.",
  "REAL, ACTIVE capabilities you may recommend: AI WhatsApp Executive (enquiries, conversation, qualification), AI Lead Intelligence (scoring and prioritisation), Autonomous AI Business Executive™ (prioritisation, next action, governed orchestration), AI Marketing Executive (campaign support), AI Content Executive (content generation), AI SALES ELITE™ (elite sales intelligence, objection handling and closing), plus CRM, AI Inbox, knowledge base, follow-up capabilities and analytics.",
  "UPCOMING (never describe as available or operational): AI Quotation Executive, AI Follow-up Executive, AI Customer Success Executive, AI Business Insights. Call them 'upcoming'; never say 'soon'.",
  "ARCHITECTURE when relevant: RÉNAIO.CORE™ (intelligence) → Islamic Implementation Layer™ (principles and governance) → UMRAVERSE® (Umrah ecosystem intelligence) → UMRAIO® (autonomous AI workforce) → Autonomous AI Business Executive™ (orchestrator) → AI specialist workforce → the agency's business outcomes. UMRAIO is a coordinated AI workforce, not a set of unrelated tools.",
  "CLAIM GOVERNANCE: never claim guaranteed sales or revenue, '100% autonomous', '100% Shariah compliant', JAKIM or Halal certification, or that AI replaces the sales team. Use 'designed to', 'helps', 'can automate', 'can identify', 'can coordinate', 'subject to appropriate governance'.",
  "ACTIONS: you are in demonstration mode with no tools. Never claim you have sent a message, notified the team, created a lead, booked anything or checked a system. If the visitor wants a human or a demo, tell them to use the Choose a Plan, Book Live Demo or Talk to our team buttons on this page, which record the request.",
  "After roughly 3-6 meaningful exchanges, summarise their current state and the opportunities you actually detected, recommend only real capabilities, and invite them to start a free trial or book a live demo.",
  "Never invent pricing.",
].join("\n");

/** Preference layer only — detection itself stays with the existing conversation intelligence. */
function languageInstruction(pref: "auto" | "ms" | "en" | undefined, detected: string): string {
  if (pref === "ms") {
    return "LANGUAGE: the visitor selected Bahasa Melayu. Reply in natural, conversational Bahasa Melayu (Malaysian business register, not formal translated Malay). Keep common business terms like enquiry, follow-up, sales, WhatsApp in English where a Malaysian would naturally use them.";
  }
  if (pref === "en") {
    return "LANGUAGE: the visitor selected English. Reply in natural professional English.";
  }
  return `LANGUAGE: Auto / Natural. Mirror the visitor's own language and style (currently detected: ${detected}). Bahasa Melayu, English, Manglish and mixed BM-English are all acceptable. Do not force formal Malay, do not force English, and never translate your own sentences.`;
}


export const Route = createFileRoute("/api/public/meet-executive")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: z.infer<typeof bodySchema>;
        try {
          body = bodySchema.parse(await request.json());
        } catch {
          return Response.json({ error: GENERIC_FAILURE }, { status: 400 });
        }
        if (!body.messages.length) {
          return Response.json({ error: GENERIC_FAILURE }, { status: 400 });
        }


        // Abuse / cost protection for this unauthenticated endpoint.
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { checkDemoRateLimit, clientIpHash } = await import("@/lib/billing/demo-limit.server");
        const gate = await checkDemoRateLimit(supabaseAdmin, clientIpHash(request));
        if (!gate.allowed) {
          return Response.json({ error: gate.message }, { status: gate.status });
        }

        const { createIntelligenceGateway } = await import("@/lib/ai/gateway.server");
        const { detectReligiousRulingRequest, RELIGIOUS_BOUNDARY_INSTRUCTION } = await import(
          "@/lib/islamic/policy.core"
        );

        const lastVisitor = [...body.messages].reverse().find((m) => m.role === "visitor");
        const religious = detectReligiousRulingRequest(lastVisitor?.content);

        // STEP 3B — deterministic B2B intelligence, reusing existing engines.
        const { analyzeMeetConversation, meetExecutiveInstruction } = await import(
          "@/lib/meet/b2b-executive.core"
        );
        // STEP 3C — B2B agency conversion & closing engine (deterministic).
        const { analyzeConversion, conversionInstruction } = await import(
          "@/lib/meet/b2b-conversion.core"
        );
        const intel = analyzeMeetConversation(body.messages);
        const conversion = analyzeConversion(intel, body.messages);

        // Customer control always wins, before any model call.
        if (intel.optedOut) {
          return Response.json({
            reply:
              "Understood — I'll stop here. No further messages from me. If you ever want to look at UMRAIO again, the buttons on this page will reach our team.",
            stopped: "opt_out",
          });
        }
        if (intel.humanRequested) {
          return Response.json({
            reply:
              "Of course. I'll stop the automated discussion here. Please use \"Talk to our team\" on this page and our specialist will continue with you directly, with the context of this conversation.",
            stopped: "human_handoff",
          });
        }

        // STEP 3D — human presence & social intelligence (deterministic).
        const { buildSocialProfile, socialPresenceInstruction } = await import(
          "@/lib/sales/social-presence.core"
        );
        const social = buildSocialProfile({
          messages: body.messages.map((m) => ({
            sender: m.role === "visitor" ? "customer" : "ai",
            body: m.content,
          })),
        });

        // STEP 3E.1 — live conversion hardening: compaction, question memory,
        // register mirroring, cold-start etiquette, Malaysian spoken register.
        const {
          compactMeetConversation,
          buildCarryOver,
          buildQuestionMemory,
          questionMemoryInstruction,
          resolveMeetRegister,
          registerMirrorInstruction,
          coldStartInstruction,
          MALAYSIAN_REGISTER_INSTRUCTION,
        } = await import("@/lib/meet/conversation-memory.core");

        // Deterministic engines above already read the FULL history; only the
        // model window is trimmed, and nothing material is lost.
        const compaction = compactMeetConversation(body.messages);
        const carryOver = buildCarryOver({
          intel,
          conversion,
          social,
          dropped: compaction.dropped,
        });

        // STEP 3F — closing & subscription execution engine (deterministic).
        const { buildClosingRead, closingInstruction } = await import(
          "@/lib/meet/closing-engine.core"
        );
        const closing = buildClosingRead({ intel, conversion, messages: body.messages });

        // STEP 3D.2 — Islamic confident sales presence (deterministic, additive).
        const { buildConfidenceRead, confidentPresenceInstruction } = await import(
          "@/lib/sales/confident-presence.core"
        );
        const confidence = buildConfidenceRead({
          customerMessages: body.messages
            .filter((m) => m.role === "visitor")
            .map((m) => m.content),
        });

        const memory = buildQuestionMemory(body.messages, intel, social);
        const register = resolveMeetRegister(
          body.messages.filter((m) => m.role === "visitor").map((m) => m.content),
        );

        // STEP 3I.1 — AI SALES ELITE™ in the UMRAIO PRODUCT sales domain.
        const { buildEliteRead, eliteSalesInstruction } = await import(
          "@/lib/sales/elite/elite-sales.core"
        );
        const visitorMessages = body.messages
          .filter((m) => m.role === "visitor")
          .map((m) => m.content);
        const elite = buildEliteRead({
          domain: "umraio_product",
          customerMessages: visitorMessages,
          activeObjections: intel.objections
            .filter((o) => o.status === "ACTIVE")
            .map((o) => String(o.category)),
          resolvedObjections: intel.objections
            .filter((o) => o.status === "RESOLVED")
            .map((o) => String(o.category)),
          buyingSignals: closing.highIntent ? ["HIGH_INTENT"] : [],
          signals: [
            ...(closing.highIntent ? ["READY_TO_BUY"] : []),
            ...(intel.frustration.length ? ["FRUSTRATED"] : []),
            ...(closing.priceQuestion || closing.paymentQuestion ? ["PRICE_CONCERN"] : []),
          ],
          known: intel.snapshot.map((s) => String(s.label ?? "")).filter(Boolean),
          missing: intel.missingFacts,
          optOut: intel.optedOut,
          humanRequested: intel.humanRequested,
        });

        const system = [
          SYSTEM,
          languageInstruction(body.language, intel.language),
          ...(body.language === "auto" || !body.language
            ? [registerMirrorInstruction(register)]
            : []),
          MALAYSIAN_REGISTER_INSTRUCTION,
          coldStartInstruction({
            social,
            visitorTurns: body.messages.filter((m) => m.role === "visitor").length,
            executiveTurns: body.messages.filter((m) => m.role === "executive").length,
          }),
          socialPresenceInstruction(social),
          ...(closing.stopDiscovery ? [] : [questionMemoryInstruction(memory)]),
          meetExecutiveInstruction(intel),
          conversionInstruction(conversion),
          closingInstruction(closing),
          eliteSalesInstruction(elite),
          RAIO_IDENTITY_INSTRUCTION,
          ISLAMIC_ELITE_PERSONA_INSTRUCTION,
          confidentPresenceInstruction(confidence),

          ...(carryOver ? [carryOver] : []),

          ...(religious.isReligiousRulingRequest
            ? [
                RELIGIOUS_BOUNDARY_INSTRUCTION,
                "You have no tools here, so do not claim an expert review was requested. Acknowledge the boundary briefly, then return to the business discussion.",
              ]
            : []),
        ].join("\n");

        const gateway = createIntelligenceGateway();
        let reply: string | null = null;
        try {
          const result = await gateway.generate({
            taskType: "business_decision",
            taskClass: "fast",
            system,
            prompt: "",
            messages: compaction.messages.map((m) => ({
              role: m.role === "visitor" ? ("user" as const) : ("assistant" as const),
              content: m.content,
            })),
          });
          reply = result.ok && result.data ? result.data : null;
          if (!reply) {
            console.error("[meet-executive] gateway returned no reply", {
              ok: result.ok,
              error: result.error ?? null,
            });
          }
        } catch (error) {
          console.error("[meet-executive] gateway threw", error);
          reply = null;
        }

        if (!reply) {
          // Never surface a raw technical error to a prospective customer.
          return Response.json(
            {
              error:
                "Maaf, saya tak dapat proses mesej itu seketika tadi. Boleh cuba sekali lagi, atau teruskan dengan Choose a Plan / Book Live Demo di halaman ini.",
            },
            { status: 503 },
          );
        }

        return Response.json({ reply });
      },
    },
  },
});
