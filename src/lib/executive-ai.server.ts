import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getAiConfig } from "./ai/config.server";
import { getProviderAdapter } from "./ai/providers.server";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;

/**
 * Provider-neutral model handle: OpenAI Direct in production, any other
 * registered adapter when configured. Never hard-wired to one vendor.
 */
function getModel() {
  const config = getAiConfig();
  return getProviderAdapter(config.provider).model(config.model, "reasoning");
}

export const WORKER_KEYS = ["whatsapp", "marketing", "content", "lead_intel"] as const;
export type WorkerKey = (typeof WORKER_KEYS)[number];

export const TASK_KINDS: Record<string, { worker: WorkerKey; label: string; minutes: number }> = {
  facebook_ads: { worker: "marketing", label: "Facebook Ads campaign", minutes: 45 },
  tiktok_ads: { worker: "marketing", label: "TikTok Ads campaign", minutes: 45 },
  google_ads: { worker: "marketing", label: "Google Ads campaign", minutes: 45 },
  whatsapp_broadcast: { worker: "marketing", label: "WhatsApp broadcast", minutes: 25 },
  daily_campaign_plan: { worker: "marketing", label: "Daily campaign plan", minutes: 30 },
  social_post: { worker: "content", label: "Social media posts", minutes: 30 },
  blog_article: { worker: "content", label: "Blog article", minutes: 90 },
  marketing_email: { worker: "content", label: "Marketing email", minutes: 35 },
  whatsapp_promo: { worker: "content", label: "WhatsApp promo messages", minutes: 20 },
  video_script: { worker: "content", label: "Video script ideas", minutes: 40 },
  lead_scoring: { worker: "lead_intel", label: "Lead scoring sweep", minutes: 60 },
  followup_sweep: { worker: "whatsapp", label: "Follow-up sweep", minutes: 40 },
};

const documentSchema = z.object({
  summary: z.string(),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })),
});
export type ExecutiveDocument = z.infer<typeof documentSchema>;

const leadIntelSchema = z.object({
  overview: z.string(),
  leads: z.array(
    z.object({
      lead_id: z.string(),
      score: z.number(),
      temperature: z.enum(["hot", "warm", "cold"]),
      booking_probability: z.number(),
      reasoning: z.string(),
      next_action: z.string(),
    }),
  ),
});

const followupSchema = z.object({
  overview: z.string(),
  followups: z.array(
    z.object({
      lead_id: z.string(),
      title: z.string(),
      message: z.string(),
      hours_from_now: z.number(),
    }),
  ),
});

async function loadAgencyContext(supabase: Db, agencyId: string) {
  const [{ data: agency }, { data: settings }, { data: packages }, { data: leads }] =
    await Promise.all([
      supabase.from("agencies").select("name, country, timezone").eq("id", agencyId).maybeSingle(),
      supabase
        .from("agency_settings")
        .select("ai_name, ai_tone, ai_personality, ai_language, ai_custom_instructions, ai_emoji")
        .eq("agency_id", agencyId)
        .maybeSingle(),
      supabase
        .from("packages")
        .select(
          "id, name, hotel_makkah, hotel_madinah, star_rating, nights, departure_date, airline, price_myr, inclusions",
        )
        .eq("is_active", true)
        .order("price_myr", { ascending: true })
        .limit(20),
      supabase
        .from("leads")
        .select(
          "id, full_name, city, stage, temperature, score, pax, budget_myr, preferred_month, package_interest, source, last_contact_at, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(60),
    ]);

  return { agency, settings, packages: packages ?? [], leads: leads ?? [] };
}

function baseSystem(ctx: Awaited<ReturnType<typeof loadAgencyContext>>) {
  return [
    `You are part of the AI Autonomous Business Executive team working for ${ctx.agency?.name ?? "an Umrah agency"} in ${ctx.agency?.country ?? "Malaysia"}.`,
    "You produce work that a senior Malaysian Umrah travel marketer would ship: specific, compliant, culturally respectful, never generic filler.",
    `Preferred language: ${ctx.settings?.ai_language ?? "Bahasa Malaysia + English mix"}. Tone: ${ctx.settings?.ai_tone ?? "warm professional"}.`,
    ctx.settings?.ai_custom_instructions
      ? `Agency instructions: ${ctx.settings.ai_custom_instructions}`
      : "",
    "Use only the real packages and lead data provided. Never invent prices, hotels or departure dates.",
    "",
    "Active packages (JSON):",
    JSON.stringify(ctx.packages),
  ]
    .filter(Boolean)
    .join("\n");
}

async function structured<T extends z.ZodTypeAny>(
  schema: T,
  system: string,
  prompt: string,
): Promise<z.infer<T>> {
  try {
    const { output } = await generateText({
      model: getModel(),
      output: Output.object({ schema }),
      system,
      prompt,
      providerOptions: { lovable: { reasoningEffort: "none" } },
    });
    return output as z.infer<T>;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      try {
        return schema.parse(JSON.parse(error.text ?? "{}"));
      } catch {
        throw new Error("The AI worker could not complete this task. Please try again.");
      }
    }
    throw error;
  }
}

const KIND_PROMPTS: Record<string, string> = {
  facebook_ads:
    "Produce a ready-to-launch Facebook/Instagram Ads campaign. Sections must cover: campaign objective & budget split, audience targeting, 3 primary texts, 3 headlines, creative direction, and measurement plan.",
  tiktok_ads:
    "Produce a TikTok Ads campaign. Sections must cover: campaign objective & budget, audience & interest targeting, 3 hook lines, a 15-second and a 30-second video concept beat-by-beat, on-screen captions, and CTA strategy.",
  google_ads:
    "Produce a Google Ads Search + Performance Max plan. Sections must cover: keyword groups with match types, negative keywords, 5 headlines and 3 descriptions, sitelink/asset ideas, landing page guidance, and budget/bid guidance.",
  whatsapp_broadcast:
    "Produce a WhatsApp broadcast campaign. Sections must cover: audience segment definition from the lead data, 3 broadcast message variants (each under 700 characters, ready to paste), best send time, and follow-up ladder.",
  daily_campaign_plan:
    "Produce today's marketing action plan. Sections must cover: priority of the day based on the real lead data, channel-by-channel actions, budget allocation in RM, and the single metric to watch.",
  social_post:
    "Produce a 5-post social media pack (Facebook, Instagram, TikTok caption, LinkedIn, X). Each section is one post: full caption, hashtags, and image/video direction.",
  blog_article:
    "Produce a complete SEO blog article. Sections must include: SEO title & meta description, introduction, at least four body sections with real substance, FAQ, and conclusion with CTA.",
  marketing_email:
    "Produce a marketing email. Sections must cover: 3 subject line options, preheader, full email body, CTA block, and a plain-text variant.",
  whatsapp_promo:
    "Produce 5 WhatsApp promotional messages of varying angles (urgency, family, first-timer, budget, premium). Each section is one ready-to-send message under 700 characters.",
  video_script:
    "Produce 3 short-form video scripts. Each section is one script with hook, beat-by-beat shot list, voiceover lines, on-screen text, and CTA.",
};

export async function runDocumentTask(
  supabase: Db,
  agencyId: string,
  kind: string,
  brief: string,
): Promise<ExecutiveDocument> {
  const ctx = await loadAgencyContext(supabase, agencyId);
  const instruction = KIND_PROMPTS[kind];
  if (!instruction) throw new Error(`Unknown task kind: ${kind}`);

  const leadSnapshot = ctx.leads.slice(0, 30).map((l: any) => ({
    stage: l.stage,
    temperature: l.temperature,
    city: l.city,
    pax: l.pax,
    budget_myr: l.budget_myr,
    preferred_month: l.preferred_month,
    package_interest: l.package_interest,
    source: l.source,
  }));

  return await structured(
    documentSchema,
    baseSystem(ctx),
    [
      instruction,
      "",
      `Agency brief from the human executive: ${brief || "No extra brief — use your judgement and the data below."}`,
      "",
      "Anonymised snapshot of the agency's current pipeline (JSON):",
      JSON.stringify(leadSnapshot),
      "",
      "Return a short summary plus the sections described above. Write final copy, not advice about copy.",
    ].join("\n"),
  );
}

export async function runLeadIntelligence(supabase: Db, agencyId: string, brief: string) {
  const ctx = await loadAgencyContext(supabase, agencyId);
  const openLeads = ctx.leads.filter(
    (l: any) => !["booked", "completed", "lost"].includes(l.stage),
  );
  if (openLeads.length === 0) {
    return {
      document: {
        summary: "No open leads to analyse right now.",
        sections: [] as ExecutiveDocument["sections"],
      },
      updated: 0,
    };
  }

  const result = await structured(
    leadIntelSchema,
    baseSystem(ctx),
    [
      "You are the AI Lead Intelligence worker. Analyse every open lead below.",
      "For each lead return: score 0-100, temperature (hot >= 70, warm >= 40, else cold), booking_probability 0-100, one-sentence reasoning, and a concrete next action for the sales team.",
      "Base scoring on data completeness, budget vs package prices, pax, recency of contact, stage and stated interest.",
      brief ? `Human executive note: ${brief}` : "",
      "",
      "Open leads (JSON):",
      JSON.stringify(openLeads),
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const byId = new Map(openLeads.map((l: any) => [l.id, l]));
  let updated = 0;
  for (const item of result.leads) {
    if (!byId.has(item.lead_id)) continue;
    const score = Math.max(0, Math.min(100, Math.round(item.score)));
    const { error } = await supabase
      .from("leads")
      .update({ score, temperature: item.temperature })
      .eq("id", item.lead_id);
    if (error) continue;
    updated += 1;
    await supabase.from("activity_log").insert({
      agency_id: agencyId,
      actor: "ai",
      action: `AI Lead Intelligence scored lead ${score}/100 (${item.temperature}) — ${item.next_action}`,
      entity: "lead",
      entity_id: item.lead_id,
      meta: { booking_probability: item.booking_probability, reasoning: item.reasoning },
    });
  }

  return {
    document: {
      summary: result.overview,
      sections: result.leads.map((item) => ({
        heading: `${(byId.get(item.lead_id) as any)?.full_name ?? "Lead"} — ${item.score}/100 · ${item.temperature}`,
        body: `Booking probability: ${Math.round(item.booking_probability)}%\n${item.reasoning}\nNext action: ${item.next_action}`,
      })),
    } satisfies ExecutiveDocument,
    updated,
  };
}

export async function runFollowupSweep(supabase: Db, agencyId: string, brief: string) {
  const ctx = await loadAgencyContext(supabase, agencyId);
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const stale = ctx.leads.filter(
    (l: any) =>
      !["booked", "completed", "lost"].includes(l.stage) &&
      new Date(l.last_contact_at ?? l.created_at).getTime() < cutoff,
  );
  if (stale.length === 0) {
    return {
      document: { summary: "Every open lead was contacted in the last 48 hours.", sections: [] },
      scheduled: 0,
    };
  }

  const result = await structured(
    followupSchema,
    baseSystem(ctx),
    [
      "You are the AI WhatsApp Executive planning a follow-up sweep.",
      "For each lead that deserves a nudge, write a ready-to-send WhatsApp follow-up message in the customer's likely language, a short internal title, and how many hours from now it should be sent (1-72).",
      brief ? `Human executive note: ${brief}` : "",
      "",
      "Leads with no contact for 48h+ (JSON):",
      JSON.stringify(stale),
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const ids = new Set(stale.map((l: any) => l.id));
  let scheduled = 0;
  for (const item of result.followups) {
    if (!ids.has(item.lead_id)) continue;
    const runAt = new Date(
      Date.now() + Math.max(1, Math.min(72, item.hours_from_now)) * 60 * 60 * 1000,
    );
    const { error } = await supabase.from("followup_jobs").insert({
      agency_id: agencyId,
      lead_id: item.lead_id,
      title: item.title,
      channel: "whatsapp",
      run_at: runAt.toISOString(),
      status: "pending",
      // Customer-facing body: only jobs carrying a body are ever dispatched.
      body: item.message,
    });
    if (error) continue;
    scheduled += 1;
    await supabase.from("activity_log").insert({
      agency_id: agencyId,
      actor: "ai",
      action: `AI WhatsApp Executive scheduled follow-up: ${item.title}`,
      entity: "lead",
      entity_id: item.lead_id,
      meta: { run_at: runAt.toISOString(), message: item.message },
    });
  }

  return {
    document: {
      summary: result.overview,
      sections: result.followups.map((item) => ({
        heading: item.title,
        body: `${item.message}\n\nSend in ~${Math.round(item.hours_from_now)}h`,
      })),
    } satisfies ExecutiveDocument,
    scheduled,
  };
}
