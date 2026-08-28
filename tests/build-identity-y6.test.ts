import { describe, expect, it } from "vitest";

import {
  buildHeaderValue,
  buildLogPayload,
  resolveBuildIdentity,
} from "../src/lib/build-identity.core";

const SHA = "10acab4737e5ce86756f11f90eccb53ef4a013b4";

describe("Y-6 build identity", () => {
  it("A. production build identity is present and complete", () => {
    const id = resolveBuildIdentity({
      commitSha: SHA,
      buildTime: "2026-08-28T19:00:00.000Z",
      mode: "production",
      packageVersion: "1.4.0",
    });
    expect(id).toEqual({
      ok: true,
      environment: "production",
      commit_sha: SHA,
      commit_short: "10acab4",
      build_time: "2026-08-28T19:00:00.000Z",
      version: "1.4.0",
    });
  });

  it("B. commit SHA is represented exactly, short derived from it", () => {
    const id = resolveBuildIdentity({ commitSha: SHA.toUpperCase(), mode: "production" });
    expect(id.commit_sha).toBe(SHA);
    expect(id.commit_short).toBe(SHA.slice(0, 7));
    expect(buildHeaderValue(id)).toBe(SHA.slice(0, 7));
  });

  it("C. payload exposes no secrets or customer data", () => {
    const id = resolveBuildIdentity({ commitSha: SHA, mode: "production" });
    expect(Object.keys(id).sort()).toEqual([
      "build_time",
      "commit_sha",
      "commit_short",
      "environment",
      "ok",
      "version",
    ]);
    const serialized = JSON.stringify({ ...id, ...buildLogPayload(id) }).toLowerCase();
    for (const forbidden of [
      "secret",
      "token",
      "api_key",
      "apikey",
      "password",
      "service_role",
      "supabase",
      "wa_id",
      "wamid",
      "phone",
      "lead",
      "quotation",
      "stripe",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("D. development and preview never claim production", () => {
    expect(resolveBuildIdentity({ commitSha: SHA, mode: "development" }).environment).toBe(
      "development",
    );
    expect(
      resolveBuildIdentity({ commitSha: SHA, mode: "production", environmentOverride: "preview" })
        .environment,
    ).toBe("preview");
    expect(resolveBuildIdentity({ commitSha: SHA, mode: "" }).environment).toBe("development");
    expect(
      resolveBuildIdentity({ commitSha: SHA, mode: "production", environmentOverride: "PRODUCTION" })
        .environment,
    ).toBe("production");
    expect(
      resolveBuildIdentity({ commitSha: SHA, mode: "development", environmentOverride: "bogus" })
        .environment,
    ).toBe("development");
  });

  it("E. missing or placeholder build metadata fails safely without inventing a SHA", () => {
    for (const value of [undefined, null, "", "unknown", "HEAD", "umraio-6.4a-fix", "not-a-sha"]) {
      const id = resolveBuildIdentity({ commitSha: value, mode: "production" });
      expect(id.ok).toBe(false);
      expect(id.commit_sha).toBeNull();
      expect(id.commit_short).toBeNull();
      expect(buildHeaderValue(id)).toBe("unknown");
    }
    const noTime = resolveBuildIdentity({ commitSha: SHA, buildTime: "nonsense" });
    expect(noTime.build_time).toBeNull();
    expect(noTime.version).toBe("0.0.0");
  });
});
