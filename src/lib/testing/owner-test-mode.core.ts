/**
 * UMRAIO® — OWNER TEST MODE (usage/allowance gates ONLY).
 *
 * A temporary, agency-scoped, owner-authorised switch that lets internal E2E
 * testing continue after a monthly usage allowance is exhausted.
 *
 * HARD BOUNDARIES (do not widen):
 *  - It bypasses ONLY the usage/allowance gates (ai_replies, ai_tasks,
 *    voice_minutes).
 *  - It NEVER changes recorded usage counters, plan, entitlement, subscription,
 *    Stripe/Paddle state, invoices or commercial limits. Counters stay truthful.
 *  - It NEVER bypasses Islamic Implementation Layer™ safety or its review
 *    workflow, WhatsApp HMAC/signature verification, authentication,
 *    authorisation, payment verification, or any other safety/security gate.
 *  - It is scoped to a single agency. There is no global bypass.
 *
 * Pure module: no network, no database, fully unit-testable.
 */

export const TEST_OVERRIDE_CATEGORIES = ["ai_replies", "ai_tasks", "voice_minutes"] as const;
export type TestOverrideCategory = (typeof TEST_OVERRIDE_CATEGORIES)[number];

/** Only the agency owner may manage test mode. Agents/admins may not. */
export const TEST_OVERRIDE_MANAGER_ROLES = ["owner"] as const;

/** Safety rail: test mode always self-expires. */
export const MAX_TEST_OVERRIDE_HOURS = 24;
export const DEFAULT_TEST_OVERRIDE_HOURS = 4;
export const MIN_REASON_LENGTH = 8;
export const MAX_REASON_LENGTH = 500;

export const TEST_MODE_ON_LABEL = "OWNER TEST MODE — ON";
export const TEST_MODE_OFF_LABEL = "Owner Test Mode — off";
export const TEST_MODE_NOTICE =
  "Test Mode is allowing execution despite the normal quota. Usage counters, plan limits and billing are unchanged.";

export type OwnerTestOverrideState = {
  enabled: boolean;
  categories: TestOverrideCategory[];
  reason: string | null;
  enabledAt: string | null;
  expiresAt: string | null;
  enabledBy: string | null;
};

export const DISABLED_OVERRIDE_STATE: OwnerTestOverrideState = {
  enabled: false,
  categories: [],
  reason: null,
  enabledAt: null,
  expiresAt: null,
  enabledBy: null,
};

export function isTestOverrideCategory(value: unknown): value is TestOverrideCategory {
  return (
    typeof value === "string" &&
    (TEST_OVERRIDE_CATEGORIES as readonly string[]).includes(value)
  );
}

export function normalizeCategories(input: unknown): TestOverrideCategory[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<TestOverrideCategory>();
  for (const raw of input) if (isTestOverrideCategory(raw)) seen.add(raw);
  return TEST_OVERRIDE_CATEGORIES.filter((c) => seen.has(c));
}

/** Owner-only. An `admin`, `agent` or `islamic_approver` role is not enough. */
export function canManageTestOverride(roles: readonly string[] | null | undefined): boolean {
  if (!Array.isArray(roles)) return false;
  return roles.some((role) => (TEST_OVERRIDE_MANAGER_ROLES as readonly string[]).includes(role));
}

export function isOverrideExpired(
  state: Pick<OwnerTestOverrideState, "expiresAt">,
  now: Date = new Date(),
): boolean {
  if (!state.expiresAt) return false;
  const expires = Date.parse(state.expiresAt);
  if (!Number.isFinite(expires)) return true; // unreadable expiry → treat as expired
  return expires <= now.getTime();
}

/**
 * The single predicate every quota gate consults. Returns true only for an
 * enabled, unexpired override that explicitly covers this category.
 */
export function isOverrideActive(
  state: OwnerTestOverrideState | null | undefined,
  category: TestOverrideCategory,
  now: Date = new Date(),
): boolean {
  if (!state || !state.enabled) return false;
  if (!state.categories.includes(category)) return false;
  return !isOverrideExpired(state, now);
}

export type EnableTestOverrideInput = {
  confirm?: unknown;
  reason?: unknown;
  categories?: unknown;
  hours?: unknown;
};

export type EnableTestOverridePlan = {
  categories: TestOverrideCategory[];
  reason: string;
  expiresAt: string;
};

export class TestOverrideValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestOverrideValidationError";
  }
}

/** Explicit confirmation + a written reason are both mandatory. */
export function validateEnableRequest(
  input: EnableTestOverrideInput,
  now: Date = new Date(),
): EnableTestOverridePlan {
  if (input.confirm !== true) {
    throw new TestOverrideValidationError(
      "Explicit confirmation is required to enable Owner Test Mode.",
    );
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < MIN_REASON_LENGTH) {
    throw new TestOverrideValidationError(
      `A reason of at least ${MIN_REASON_LENGTH} characters is required.`,
    );
  }
  const categories = normalizeCategories(input.categories);
  if (categories.length === 0) {
    throw new TestOverrideValidationError("Select at least one usage category to override.");
  }
  const requestedHours =
    typeof input.hours === "number" && Number.isFinite(input.hours)
      ? input.hours
      : DEFAULT_TEST_OVERRIDE_HOURS;
  const hours = Math.min(MAX_TEST_OVERRIDE_HOURS, Math.max(1, Math.round(requestedHours)));

  return {
    categories,
    reason: reason.slice(0, MAX_REASON_LENGTH),
    expiresAt: new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString(),
  };
}

/** Human-readable status used by the console indicator. */
export function describeOverride(
  state: OwnerTestOverrideState,
  now: Date = new Date(),
): { on: boolean; label: string; detail: string } {
  const on = state.enabled && !isOverrideExpired(state, now);
  if (!on) {
    return {
      on: false,
      label: TEST_MODE_OFF_LABEL,
      detail: "Normal plan quota enforcement is active.",
    };
  }
  return {
    on: true,
    label: TEST_MODE_ON_LABEL,
    detail: `${TEST_MODE_NOTICE} Categories: ${state.categories.join(", ")}.`,
  };
}
