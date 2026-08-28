/**
 * Y-6 — Build & deployment traceability (pure core).
 *
 * Single canonical shape for "which build is serving this request". Contains
 * no secrets, no customer data and never fabricates a commit SHA: when the
 * build metadata is missing the identity reports `ok: false` with null fields.
 */

export type BuildEnvironment = "production" | "preview" | "development";

export type BuildIdentity = {
  ok: boolean;
  environment: BuildEnvironment;
  commit_sha: string | null;
  commit_short: string | null;
  build_time: string | null;
  version: string;
};

export type BuildIdentityInput = {
  /** Full git SHA baked in at build time. */
  commitSha?: string | null | undefined;
  /** ISO timestamp of the build. */
  buildTime?: string | null | undefined;
  /** Vite mode ("production" | "development" | ...). */
  mode?: string | null | undefined;
  /** Explicit deployment environment override (e.g. BUILD_ENVIRONMENT). */
  environmentOverride?: string | null | undefined;
  /** Package version, informational only. */
  packageVersion?: string | null | undefined;
};

const PLACEHOLDERS = new Set(["", "unknown", "undefined", "null", "none", "HEAD", "umraio-6.4a-fix"]);

/** A real SHA only — anything else is treated as missing rather than invented. */
function normalizeSha(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (PLACEHOLDERS.has(trimmed)) return null;
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

function normalizeTime(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (PLACEHOLDERS.has(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function resolveBuildEnvironment(input: BuildIdentityInput): BuildEnvironment {
  const override = (input.environmentOverride ?? "").trim().toLowerCase();
  if (override === "production" || override === "preview" || override === "development") {
    return override;
  }
  const mode = (input.mode ?? "").trim().toLowerCase();
  if (mode === "production") return "production";
  if (mode === "development") return "development";
  return "development";
}

export function resolveBuildIdentity(input: BuildIdentityInput): BuildIdentity {
  const sha = normalizeSha(input.commitSha);
  const buildTime = normalizeTime(input.buildTime);
  const environment = resolveBuildEnvironment(input);
  const version = (input.packageVersion ?? "").trim() || "0.0.0";

  return {
    ok: sha !== null,
    environment,
    commit_sha: sha,
    commit_short: sha ? sha.slice(0, 7) : null,
    build_time: buildTime,
    version,
  };
}

/** Header-safe short build label; `unknown` when no real SHA exists. */
export function buildHeaderValue(identity: BuildIdentity): string {
  return identity.commit_short ?? "unknown";
}

/** Stable log line payload for startup / request tracing. */
export function buildLogPayload(identity: BuildIdentity) {
  return {
    event: "build_identity",
    environment: identity.environment,
    commit_short: identity.commit_short,
    build_time: identity.build_time,
    version: identity.version,
  };
}
