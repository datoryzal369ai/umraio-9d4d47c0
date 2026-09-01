/**
 * UMRAIO® Developer Technical Operations Console — pure core (V1, read-only).
 *
 * Contains NO authorization logic and NO data access. Every helper here shapes
 * an allow-listed, non-sensitive diagnostic payload. Nothing in this module may
 * carry customer data, secrets, prompts, or RÉNAIO.CORE™ / RENAGI™ internals.
 */

import { redactAndCap } from "@/lib/ai/redaction";

export type DevStatus = "healthy" | "degraded" | "error" | "unknown";
export type DevConfigState = "configured" | "missing";

/** Environment variables surfaced by NAME ONLY — values never leave the server. */
export const DEVELOPER_ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "AI_PROVIDER",
  "OPENAI_API_KEY",
  "LOVABLE_API_KEY",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "PADDLE_API_KEY",
  "MINIMAX_TTS_API_KEY",
  "MINIMAX_TTS_GROUP_ID",
  "VOICE_TTS_ENGINE",
  "XIAOZHI_TTS_URL",
  "CRON_SECRET",
] as const;

export type DevEnvEntry = { name: string; state: DevConfigState };

/** Presence-only projection. Never returns, hashes or truncates a value. */
export function describeEnvPresence(
  read: (name: string) => string | undefined,
  keys: readonly string[] = DEVELOPER_ENV_KEYS,
): DevEnvEntry[] {
  return keys.map((name) => {
    const raw = read(name);
    return { name, state: (raw && raw.trim() ? "configured" : "missing") as DevConfigState };
  });
}

export type DevIntegration = {
  key: string;
  label: string;
  state: DevConfigState;
  status: DevStatus;
  detail: string;
  latencyMs: number | null;
};

export function integration(
  key: string,
  label: string,
  configured: boolean,
  detail: string,
  latencyMs: number | null = null,
): DevIntegration {
  return {
    key,
    label,
    state: configured ? "configured" : "missing",
    status: configured ? "healthy" : "degraded",
    detail,
    latencyMs,
  };
}

/** Error class only — no stack, no message internals, no payloads. */
export function errorClass(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  if (typeof error === "string") return "StringError";
  return "UnknownError";
}

export type DevErrorEntry = {
  id: string;
  correlationId: string;
  occurredAt: string;
  errorClass: string;
  message: string;
};

/**
 * Sanitize a diagnostic error row. The message passes through the shared
 * redaction utilities and is hard-capped; identifiers are opaque UUIDs only.
 */
export function sanitizeErrorEntry(row: {
  id: string;
  created_at: string;
  kind?: string | null;
  error?: string | null;
}): DevErrorEntry {
  const raw = (row.error ?? "").trim();
  const cls = raw.match(/^([A-Za-z_$][\w$]*Error)\b/)?.[1] ?? "OperationalError";
  return {
    id: row.id,
    correlationId: row.id,
    occurredAt: row.created_at,
    errorClass: cls,
    message: redactAndCap(raw, 180) || "(no diagnostic detail)",
  };
}

export type DevJobStats = {
  jobType: string;
  queueDepth: number;
  retryCount: number;
  stuckCount: number;
  lastExecution: string | null;
};

export type DevSecurityIndicator = {
  key: string;
  label: string;
  detail: string;
  status: "audited";
};

/** Read-only status/audit indicators. Not a live scan. */
export const DEVELOPER_SECURITY_INDICATORS: DevSecurityIndicator[] = [
  {
    key: "rls",
    label: "RLS coverage",
    detail: "Row Level Security enabled on all tenant tables.",
    status: "audited",
  },
  {
    key: "anon_dml",
    label: "Anonymous DML hardening",
    detail: "INSERT/UPDATE/DELETE revoked from the anonymous role on public tables.",
    status: "audited",
  },
  {
    key: "whatsapp_token",
    label: "WhatsApp access-token protection",
    detail: "Token column is not selectable by authenticated users.",
    status: "audited",
  },
  {
    key: "quotation",
    label: "Public quotation security",
    detail: "Rate limiting plus customer-safe field projection on public links.",
    status: "audited",
  },
  {
    key: "webhook_signature",
    label: "Webhook signature protection",
    detail: "Meta and payment webhooks verify signatures before processing.",
    status: "audited",
  },
  {
    key: "tenant",
    label: "Tenant isolation",
    detail: "Agency scoping enforced by security-definer tenant resolution.",
    status: "audited",
  },
];

export type DevTask = {
  id: string;
  task: string;
  priority: "P0" | "P1" | "P2";
  status: "open" | "in_progress" | "done";
  updatedAt: string;
};

/** Engineering task board. Static, non-customer, non-proprietary. */
export const DEVELOPER_TASKS: DevTask[] = [
  {
    id: "dev-1",
    task: "Wire live integration probes (currently configuration-state only)",
    priority: "P1",
    status: "open",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: "dev-2",
    task: "Publish CI validation snapshot automatically after each run",
    priority: "P1",
    status: "open",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: "dev-3",
    task: "Structured error telemetry store for correlation IDs",
    priority: "P2",
    status: "open",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
];

/**
 * Latest validation snapshot (tests / typecheck). Updated when the release
 * validation suite runs; purely informational.
 */
export const DEVELOPER_VALIDATION_SNAPSHOT = {
  testsPassed: 1186,
  testsFailed: 0,
  testsSkipped: 3,
  testFiles: 89,
  typecheck: "clean" as "clean" | "failing",
  validatedAt: "2026-09-01T00:00:00.000Z",
};

/** Guard: the console response must never carry forbidden field names. */
const FORBIDDEN_KEYS = [
  "access_token",
  "api_key",
  "apikey",
  "secret",
  "service_role",
  "phone",
  "wa_id",
  "body",
  "message_body",
  "prompt",
  "system_prompt",
  "reasoning",
  "trace",
  "customer",
];

export function containsForbiddenKeys(value: unknown, path: string[] = []): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...containsForbiddenKeys(item, [...path, String(i)])));
    return hits;
  }
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.includes(key.toLowerCase())) hits.push([...path, key].join("."));
      hits.push(...containsForbiddenKeys(val, [...path, key]));
    }
  }
  return hits;
}
