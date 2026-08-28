/**
 * Y-6 — runtime binding of the canonical build identity.
 *
 * Values are injected at build time by `vite.config.ts` (`define`). Nothing
 * here reads secrets; the identity is safe to log and to expose on the
 * diagnostic endpoint.
 */
import {
  resolveBuildIdentity,
  buildHeaderValue,
  buildLogPayload,
  type BuildIdentity,
} from "./build-identity.core";

declare const __BUILD_COMMIT_SHA__: string;
declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;
declare const __BUILD_MODE__: string;
declare const __APP_VERSION__: string;

function define(name: string, value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : (void name, null);
}

function envOverride(): string | null {
  try {
    return typeof process !== "undefined" ? (process.env?.["BUILD_ENVIRONMENT"] ?? null) : null;
  } catch {
    return null;
  }
}

export const BUILD_IDENTITY: BuildIdentity = resolveBuildIdentity({
  commitSha:
    define("sha", typeof __BUILD_COMMIT_SHA__ !== "undefined" ? __BUILD_COMMIT_SHA__ : null) ??
    define("short", typeof __BUILD_COMMIT__ !== "undefined" ? __BUILD_COMMIT__ : null),
  buildTime: define("time", typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : null),
  mode: define("mode", typeof __BUILD_MODE__ !== "undefined" ? __BUILD_MODE__ : null),
  environmentOverride: envOverride(),
  packageVersion: define("version", typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : null),
});

export const BUILD_HEADER_VALUE = buildHeaderValue(BUILD_IDENTITY);

export { buildLogPayload };
export type { BuildIdentity };
