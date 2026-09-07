import { supabase } from "@/integrations/supabase/client";

export type AnalyticsLead = {
  id: string;
  full_name: string;
  source: string;
  stage: string;
  temperature: string;
  score: number;
  budget_myr: number | null;
  created_at: string;
};

export type AnalyticsBooking = {
  id: string;
  package_id: string | null;
  pax: number;
  amount_myr: number;
  status: string;
  deposit_paid: boolean;
  created_at: string;
};

export type AnalyticsFollowup = {
  id: string;
  status: string;
  channel: string;
  run_at: string;
  created_at: string;
};

export type AnalyticsPackage = { id: string; name: string; price_myr: number };

export type AnalyticsMessage = { id: string; sender: string; created_at: string };

export type AnalyticsData = {
  leads: AnalyticsLead[];
  bookings: AnalyticsBooking[];
  followups: AnalyticsFollowup[];
  packages: AnalyticsPackage[];
  messages: AnalyticsMessage[];
};

export const RANGES = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last 12 months" },
] as const;

const sinceIso = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

export async function fetchAnalytics(days: number): Promise<AnalyticsData> {
  const since = sinceIso(days);
  const [leads, bookings, followups, packages, messages] = await Promise.all([
    supabase
      .from("leads")
      .select("id, full_name, source, stage, temperature, score, budget_myr, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase
      .from("bookings")
      .select("id, package_id, pax, amount_myr, status, deposit_paid, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase
      .from("followup_jobs")
      .select("id, status, channel, run_at, created_at")
      .gte("created_at", since)
      .limit(1000),
    supabase.from("packages").select("id, name, price_myr").limit(200),
    // Internal call-summary notes are not outbound messages — keep AI-share metrics honest.
    supabase
      .from("messages")
      .select("id, sender, created_at")
      .gte("created_at", since)
      .neq("modality", "call_summary")
      .limit(2000),
  ]);

  return {
    leads: (leads.data ?? []) as AnalyticsLead[],
    bookings: (bookings.data ?? []).map((b) => ({
      ...b,
      amount_myr: Number(b.amount_myr ?? 0),
    })) as AnalyticsBooking[],
    followups: (followups.data ?? []) as AnalyticsFollowup[],
    packages: (packages.data ?? []).map((p) => ({
      ...p,
      price_myr: Number(p.price_myr ?? 0),
    })) as AnalyticsPackage[],
    messages: (messages.data ?? []) as AnalyticsMessage[],
  };
}

/* ---------- derived series ---------- */

export const FUNNEL_STAGES = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "qualified", label: "Qualified" },
  { key: "negotiation", label: "Negotiation" },
  { key: "booked", label: "Booked" },
  { key: "completed", label: "Completed" },
] as const;

const STAGE_ORDER = FUNNEL_STAGES.map((s) => s.key) as string[];

export function funnelSeries(data: AnalyticsData) {
  const total = data.leads.filter((l) => l.stage !== "lost").length;
  return FUNNEL_STAGES.map((stage, index) => {
    const count = data.leads.filter((l) => {
      const pos = STAGE_ORDER.indexOf(l.stage);
      return l.stage !== "lost" && pos >= index;
    }).length;
    return {
      stage: stage.label,
      leads: count,
      rate: total ? Math.round((count / total) * 100) : 0,
    };
  });
}

export function sourceSeries(data: AnalyticsData) {
  const map = new Map<string, { leads: number; booked: number }>();
  for (const lead of data.leads) {
    const key = lead.source || "unknown";
    const entry = map.get(key) ?? { leads: 0, booked: 0 };
    entry.leads += 1;
    if (lead.stage === "booked" || lead.stage === "completed") entry.booked += 1;
    map.set(key, entry);
  }
  return [...map.entries()]
    .map(([source, v]) => ({
      source: source.charAt(0).toUpperCase() + source.slice(1),
      ...v,
      rate: v.leads ? Math.round((v.booked / v.leads) * 100) : 0,
    }))
    .sort((a, b) => b.leads - a.leads);
}

export function topPackages(data: AnalyticsData, limit = 6) {
  const names = new Map(data.packages.map((p) => [p.id, p.name]));
  const map = new Map<string, { bookings: number; revenue: number; pax: number }>();
  for (const booking of data.bookings) {
    if (booking.status === "cancelled") continue;
    const key = booking.package_id ?? "unassigned";
    const entry = map.get(key) ?? { bookings: 0, revenue: 0, pax: 0 };
    entry.bookings += 1;
    entry.revenue += booking.amount_myr;
    entry.pax += booking.pax;
    map.set(key, entry);
  }
  return [...map.entries()]
    .map(([id, v]) => ({ name: names.get(id) ?? "Custom / unassigned", ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

export function monthKeys(days: number) {
  const months = days <= 30 ? 3 : days <= 90 ? 4 : days <= 180 ? 6 : 12;
  const now = new Date();
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
    return { start: d, end: new Date(d.getFullYear(), d.getMonth() + 1, 1) };
  });
}

export function trendSeries(data: AnalyticsData, days: number) {
  return monthKeys(days).map(({ start, end }) => {
    const within = (iso: string) => {
      const t = new Date(iso).getTime();
      return t >= start.getTime() && t < end.getTime();
    };
    const leads = data.leads.filter((l) => within(l.created_at));
    const bookings = data.bookings.filter((b) => within(b.created_at));
    const revenue = bookings.reduce((sum, b) => sum + b.amount_myr, 0);
    return {
      month: start.toLocaleString("en-MY", { month: "short" }),
      leads: leads.length,
      bookings: bookings.length,
      revenue,
      conversion: leads.length ? Math.round((bookings.length / leads.length) * 100) : 0,
      pax: bookings.reduce((sum, b) => sum + b.pax, 0),
    };
  });
}

export function followupSeries(data: AnalyticsData, days: number) {
  return monthKeys(days).map(({ start, end }) => {
    const within = (iso: string) => {
      const t = new Date(iso).getTime();
      return t >= start.getTime() && t < end.getTime();
    };
    const rows = data.followups.filter((f) => within(f.created_at));
    const count = (status: string) => rows.filter((f) => f.status === status).length;
    return {
      month: start.toLocaleString("en-MY", { month: "short" }),
      sent: count("sent"),
      pending: count("pending"),
      skipped: count("skipped") + count("failed"),
    };
  });
}

export function summary(data: AnalyticsData) {
  const totalLeads = data.leads.length;
  const booked = data.leads.filter((l) => l.stage === "booked" || l.stage === "completed").length;
  const revenue = data.bookings
    .filter((b) => b.status !== "cancelled")
    .reduce((sum, b) => sum + b.amount_myr, 0);
  const aiMessages = data.messages.filter((m) => m.sender === "ai").length;
  const followupsSent = data.followups.filter((f) => f.status === "sent").length;
  const followupTotal = data.followups.length;
  return {
    totalLeads,
    booked,
    conversion: totalLeads ? (booked / totalLeads) * 100 : 0,
    revenue,
    avgDeal: data.bookings.length ? revenue / data.bookings.length : 0,
    aiMessages,
    aiShare: data.messages.length ? (aiMessages / data.messages.length) * 100 : 0,
    followupsSent,
    followupRate: followupTotal ? (followupsSent / followupTotal) * 100 : 0,
    hotLeads: data.leads.filter((l) => l.temperature === "hot").length,
  };
}
