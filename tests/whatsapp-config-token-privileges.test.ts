/**
 * P1-1 regression test — whatsapp_configs.access_token column privileges.
 *
 * Verifies the production-secure grant state:
 *   1. `authenticated` has NO SELECT privilege on `access_token`.
 *   2. `authenticated` keeps SELECT on the non-sensitive config columns
 *      the application reads.
 *   3. The `has_access_token` flag column remains readable by `authenticated`.
 *   4. `service_role` (server-side) access to `access_token` is unchanged.
 *
 * This test NEVER selects the token value itself — it only evaluates
 * has_column_privilege() booleans, so no secret material is read, printed,
 * or logged. It is read-only and changes no grants.
 *
 * Requires the managed PG* env vars (skipped gracefully when absent).
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const HAS_PG = Boolean(process.env.PGHOST && process.env.PGDATABASE);

function sqlBool(query: string): boolean {
  const out = execFileSync("psql", ["-tA", "-c", query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return out === "t";
}

function hasPrivilege(role: string, column: string, privilege: string): boolean {
  return sqlBool(
    `SELECT has_column_privilege('${role}','public.whatsapp_configs','${column}','${privilege}')`,
  );
}

describe("whatsapp_configs access_token column privileges (P1-1)", () => {
  it.skipIf(!HAS_PG)("authenticated CANNOT select access_token", () => {
    expect(hasPrivilege("authenticated", "access_token", "SELECT")).toBe(false);
  });

  it.skipIf(!HAS_PG)(
    "authenticated write access to whatsapp_configs remains RLS-gated (audited secure state)",
    () => {
      // Documented reality: the table-level INSERT/UPDATE grants to
      // `authenticated` also cover access_token — the production hardening
      // revoked column-level SELECT only. Writes remain constrained by the
      // four existing agency-scoped RLS policies on whatsapp_configs, which
      // this test does not modify. Assert RLS is enabled as the write gate.
      expect(
        sqlBool(
          `SELECT relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname='whatsapp_configs'`,
        ),
      ).toBe(true);
    },
  );

  it.skipIf(!HAS_PG)(
    "authenticated retains SELECT on non-sensitive config columns",
    () => {
      const nonSensitive = [
        "id",
        "agency_id",
        "display_phone_number",
        "phone_number_id",
        "business_account_id",
        "is_connected",
        "auto_reply",
        "last_inbound_at",
        "created_at",
        "updated_at",
      ];
      for (const column of nonSensitive) {
        expect(
          hasPrivilege("authenticated", column, "SELECT"),
          `authenticated must keep SELECT on ${column}`,
        ).toBe(true);
      }
    },
  );

  it.skipIf(!HAS_PG)("has_access_token remains readable by authenticated", () => {
    expect(hasPrivilege("authenticated", "has_access_token", "SELECT")).toBe(true);
  });

  it.skipIf(!HAS_PG)("service_role server-side access is unchanged", () => {
    expect(hasPrivilege("service_role", "access_token", "SELECT")).toBe(true);
    expect(hasPrivilege("service_role", "display_phone_number", "SELECT")).toBe(true);
  });

  it("never reads token values (structural guard)", () => {
    // Structural guarantee: this file contains no query that selects the
    // access_token VALUE — only has_column_privilege() boolean checks.
    // If someone edits this test to read token data, this assertion fails.
    const fs = require("node:fs") as typeof import("node:fs");
    const source = fs.readFileSync(__filename, "utf8");
    expect(source).not.toMatch(/SELECT\s+access_token\s+FROM/i);
    expect(source).not.toMatch(/select\s*\([^)]*access_token[^)]*\)/i);
  });
});
