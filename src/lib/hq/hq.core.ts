/**
 * UMRAIO HQ — pure shaping helpers for the platform-owner visibility layer.
 *
 * No authorization happens here: every function in this module assumes the
 * caller has already been verified as a platform owner server-side.
 */

export type HqAgencyRow = {
  id: string;
  name: string;
  plan: string | null;
  created_at: string;
};

export type HqProfileRow = {
  id: string;
  agency_id: string | null;
  full_name: string | null;
  email: string | null;
  last_seen_at: string | null;
};

export type HqRoleRow = {
  user_id: string;
  agency_id: string | null;
  role: string;
};

export type HqEntitlementRow = {
  agency_id: string;
  effective_plan: string | null;
  source: string | null;
};

export type HqAgencySummary = {
  id: string;
  name: string;
  plan: string;
  planSource: string | null;
  createdAt: string;
  userCount: number;
  ownerName: string | null;
  ownerEmail: string | null;
};

export type HqUser = {
  id: string;
  name: string;
  email: string | null;
  roles: string[];
  lastSeenAt: string | null;
};

/** Role shown first when a user holds more than one. */
const ROLE_PRIORITY = ["platform_owner", "owner", "admin", "islamic_approver", "agent"];

export function sortRoles(roles: string[]): string[] {
  return [...new Set(roles)].sort((a, b) => {
    const ai = ROLE_PRIORITY.indexOf(a);
    const bi = ROLE_PRIORITY.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

export function rolesByUser(roles: HqRoleRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of roles) {
    const list = map.get(row.user_id) ?? [];
    list.push(row.role);
    map.set(row.user_id, sortRoles(list));
  }
  return map;
}

export function buildAgencySummaries(
  agencies: HqAgencyRow[],
  profiles: HqProfileRow[],
  roles: HqRoleRow[],
  entitlements: HqEntitlementRow[] = [],
): HqAgencySummary[] {
  const roleMap = rolesByUser(roles);
  const entMap = new Map(entitlements.map((e) => [e.agency_id, e]));

  return agencies.map((agency) => {
    const members = profiles.filter((p) => p.agency_id === agency.id);
    const owner =
      members.find((m) => (roleMap.get(m.id) ?? []).includes("owner")) ?? members[0] ?? null;
    const ent = entMap.get(agency.id);

    return {
      id: agency.id,
      name: agency.name,
      plan: ent?.effective_plan ?? agency.plan ?? "unknown",
      planSource: ent?.source ?? null,
      createdAt: agency.created_at,
      userCount: members.length,
      ownerName: owner?.full_name?.trim() || null,
      ownerEmail: owner?.email ?? null,
    };
  });
}

export function buildAgencyUsers(profiles: HqProfileRow[], roles: HqRoleRow[]): HqUser[] {
  const roleMap = rolesByUser(roles);
  return profiles
    .map((p) => ({
      id: p.id,
      name: p.full_name?.trim() || "(unnamed)",
      email: p.email,
      roles: roleMap.get(p.id) ?? [],
      lastSeenAt: p.last_seen_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A UUID is the only acceptable agency selector coming from the client. */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/* ── Founder HQ Control Center v1 ─────────────────────────────────────── */

export type HqLoginEventRow = {
  id: string;
  user_id: string;
  agency_id: string | null;
  event_type: string;
  session_key: string | null;
  occurred_at: string;
};

export type HqActivityRow = {
  id: string;
  agency_id: string;
  actor: string;
  actor_user_id: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
};

export type HqPlatformStats = {
  totalAgencies: number;
  totalUsers: number;
  activeAgencies: number;
  trialAgencies: number;
  activeSubscriptions: number;
  recentlyActiveUsers: number;
  recentLogins: number;
};

/** Masks a session key so it is never fully exposed in the Founder HQ UI. */
export function maskSessionKey(key: string | null | undefined): string {
  if (!key) return "—";
  const trimmed = String(key);
  if (trimmed.length <= 6) return "••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-2)}`;
}

const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Platform-level counters derived strictly from existing rows. */
export function buildPlatformStats(
  agencies: HqAgencySummary[],
  profiles: HqProfileRow[],
  logins: HqLoginEventRow[],
  now: number = Date.now(),
): HqPlatformStats {
  const since = now - ACTIVE_WINDOW_MS;
  const activeAgencyIds = new Set(
    profiles
      .filter((p) => p.last_seen_at && new Date(p.last_seen_at).getTime() >= since)
      .map((p) => p.agency_id)
      .filter(Boolean) as string[],
  );

  const paidPlans = new Set(["basic", "pro", "premium", "founding"]);

  return {
    totalAgencies: agencies.length,
    totalUsers: profiles.length,
    activeAgencies: agencies.filter((a) => activeAgencyIds.has(a.id)).length,
    trialAgencies: agencies.filter((a) => (a.plan ?? "").toLowerCase() === "trial").length,
    activeSubscriptions: agencies.filter((a) => paidPlans.has((a.plan ?? "").toLowerCase())).length,
    recentlyActiveUsers: profiles.filter(
      (p) => p.last_seen_at && new Date(p.last_seen_at).getTime() >= since,
    ).length,
    recentLogins: logins.filter((e) => new Date(e.occurred_at).getTime() >= since).length,
  };
}

/** Last activity timestamp per agency, from presence + login events. */
export function lastActivityByAgency(
  profiles: HqProfileRow[],
  logins: HqLoginEventRow[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const push = (agencyId: string | null, iso: string | null) => {
    if (!agencyId || !iso) return;
    if (!out[agencyId] || new Date(iso) > new Date(out[agencyId])) out[agencyId] = iso;
  };
  for (const p of profiles) push(p.agency_id, p.last_seen_at);
  for (const e of logins) push(e.agency_id, e.occurred_at);
  return out;
}

export type HqSecurityCheck = {
  key: string;
  label: string;
  detail: string;
  /** "verified" statuses come from the recorded security audit, not a live probe. */
  status: "audited";
};

/** Read-only Founder security summary. No secrets, no live mutation. */
export const HQ_SECURITY_CHECKS: HqSecurityCheck[] = [
  {
    key: "rls",
    label: "RLS coverage",
    detail: "Row Level Security enabled on all tenant tables.",
    status: "audited",
  },
  {
    key: "tenant",
    label: "Tenant isolation",
    detail: "Agency scoping enforced by security-definer tenant resolution.",
    status: "audited",
  },
  {
    key: "whatsapp",
    label: "WhatsApp access-token protection",
    detail: "Token column not selectable by authenticated users.",
    status: "audited",
  },
  {
    key: "anon_dml",
    label: "Anonymous DML hardening",
    detail: "INSERT/UPDATE/DELETE revoked from anonymous role on public tables.",
    status: "audited",
  },
  {
    key: "quotation",
    label: "Public quotation protection",
    detail: "Rate limiting plus customer-safe field projection on public links.",
    status: "audited",
  },
  {
    key: "dnc",
    label: "DNC safety",
    detail: "Current-turn stop rule blocks AI replies and proactive outbound.",
    status: "audited",
  },
  {
    key: "platform_owner",
    label: "Platform-owner protection",
    detail: "Founder HQ authorization verified server-side on every request.",
    status: "audited",
  },
];

/* ── Founder HQ Channel Activity v1 ───────────────────────────────────── */

export type HqChannel = "WHATSAPP_TEXT" | "VOICE_NOTE" | "LIVE_CALL";
export type HqInteractionStatus =
  "SUCCESS" | "FAILED" | "PARTIAL" | "PENDING" | "BLOCKED" | "HUMAN_REQUIRED" | "UNKNOWN";

export type HqChannelActivityItem = {
  id: string;
  occurredAt: string;
  channel: HqChannel;
  direction: "inbound" | "outbound" | "unknown";
  agencyId: string | null;
  agencyName: string;
  contactPhone: string;
  contactName: string;
  leadId: string | null;
  interactionStatus: HqInteractionStatus;
  /** Metadata-only description. Never a customer message body. */
  summary: string;
  sourceType: "message" | "call_session";
  sourceId: string;
};

export type HqMessageRow = {
  id: string;
  agency_id: string;
  conversation_id: string;
  sender: string;
  modality: string | null;
  delivery_status: string | null;
  created_at: string;
};

export type HqConversationRow = {
  id: string;
  lead_id: string | null;
  channel: string | null;
  human_attention_required: boolean | null;
};

export type HqLeadRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  do_not_contact: boolean | null;
};

export type HqCallSessionRow = {
  id: string;
  agency_id: string;
  lead_id: string | null;
  caller_phone: string | null;
  direction: string | null;
  status: string | null;
  termination_reason: string | null;
  received_at: string;
  answered_at: string | null;
  ended_at: string | null;
  turn_count: number | null;
};

const UNKNOWN_LABEL = "Unresolved";

/** Only the last 4 digits of a customer phone are ever shown in Founder HQ. */
export function maskPhone(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return UNKNOWN_LABEL;
  if (digits.length <= 4) return `••${digits.slice(-2)}`;
  return `••••${digits.slice(-4)}`;
}

export function normalizeMessageChannel(modality: string | null | undefined): HqChannel | null {
  if (modality === "audio") return "VOICE_NOTE";
  if (!modality || modality === "text") return "WHATSAPP_TEXT";
  // image / document / unsupported / call_summary are out of scope for Phase 1.
  return null;
}

export function normalizeMessageStatus(
  deliveryStatus: string | null | undefined,
): HqInteractionStatus {
  // Historical status is derived from event-level delivery evidence only.
  // "sent" proves provider send/accept stage, not delivery/read.
  switch (deliveryStatus) {
    case "read":
    case "delivered":
      return "SUCCESS";
    case "sent":
      return "PARTIAL";
    case "failed":
      return "FAILED";
    case "pending":
    case "queued":
      return "PENDING";
    default:
      return "UNKNOWN";
  }
}

export function normalizeCallStatus(row: {
  status: string | null | undefined;
  termination_reason: string | null | undefined;
  answered_at: string | null | undefined;
}): HqInteractionStatus {
  const status = row.status ?? "";
  if (status === "failed") return "FAILED";
  if (status === "terminated") {
    if (row.termination_reason === "completed") return row.answered_at ? "SUCCESS" : "PARTIAL";
    if (!row.answered_at) return "FAILED";
    return "PARTIAL";
  }
  if (status === "answered") return row.answered_at ? "PARTIAL" : "PENDING";
  if (status === "ringing" || status === "connecting" || status === "received") return "PENDING";
  return "UNKNOWN";
}

function messageDirection(sender: string): HqChannelActivityItem["direction"] {
  if (sender === "customer") return "inbound";
  if (sender === "ai" || sender === "human") return "outbound";
  return "unknown";
}

/** Metadata-only summaries. Message bodies are never surfaced. */
function messageSummary(sender: string, channel: HqChannel): string {
  const who = sender === "customer" ? "Customer" : sender === "ai" ? "RAIŌ" : "Agent";
  return channel === "VOICE_NOTE" ? `${who} voice note` : `${who} WhatsApp message`;
}

export function buildChannelActivity(input: {
  messages: HqMessageRow[];
  conversations: HqConversationRow[];
  calls: HqCallSessionRow[];
  leads: HqLeadRow[];
  agencyNames: Map<string, string>;
  limit?: number;
}): HqChannelActivityItem[] {
  const convById = new Map(input.conversations.map((c) => [c.id, c]));
  const leadById = new Map(input.leads.map((l) => [l.id, l]));
  const agencyName = (id: string | null) =>
    (id ? input.agencyNames.get(id) : null) ?? UNKNOWN_LABEL;

  const items: HqChannelActivityItem[] = [];

  for (const m of input.messages) {
    const channel = normalizeMessageChannel(m.modality);
    if (!channel) continue;
    const conv = convById.get(m.conversation_id) ?? null;
    const lead = conv?.lead_id ? (leadById.get(conv.lead_id) ?? null) : null;
    const blocked = lead?.do_not_contact === true && m.sender !== "customer";
    items.push({
      id: `msg:${m.id}`,
      occurredAt: m.created_at,
      channel,
      direction: messageDirection(m.sender),
      agencyId: m.agency_id,
      agencyName: agencyName(m.agency_id),
      contactPhone: maskPhone(lead?.phone),
      contactName: lead?.full_name?.trim() || UNKNOWN_LABEL,
      leadId: lead?.id ?? null,
      interactionStatus: blocked
        ? "BLOCKED"
        : normalizeMessageStatus(m.delivery_status, conv?.human_attention_required),
      summary: messageSummary(m.sender, channel),
      sourceType: "message",
      sourceId: m.id,
    });
  }

  for (const c of input.calls) {
    const lead = c.lead_id ? (leadById.get(c.lead_id) ?? null) : null;
    const turns = c.turn_count ?? 0;
    items.push({
      id: `call:${c.id}`,
      occurredAt: c.received_at,
      channel: "LIVE_CALL",
      direction: c.direction === "inbound" || c.direction === "outbound" ? c.direction : "unknown",
      agencyId: c.agency_id,
      agencyName: agencyName(c.agency_id),
      contactPhone: maskPhone(c.caller_phone ?? lead?.phone),
      contactName: lead?.full_name?.trim() || UNKNOWN_LABEL,
      leadId: lead?.id ?? null,
      interactionStatus: normalizeCallStatus(c),
      summary: `Live call · ${turns} turn${turns === 1 ? "" : "s"}${
        c.termination_reason ? ` · ${c.termination_reason}` : ""
      }`,
      sourceType: "call_session",
      sourceId: c.id,
    });
  }

  return items
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, input.limit ?? 200);
}
