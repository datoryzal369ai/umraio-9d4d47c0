import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  LOGIN_EVENT_TYPES,
  decideLoginEvent,
  humanActor,
  isAllowedLoginEventType,
  isOnline,
  presenceStatus,
  sessionKeyOf,
  shouldSendHeartbeat,
} from "@/lib/identity/identity.core";

import { readdirSync } from "node:fs";

const migration = readdirSync("supabase/migrations")
  .map((f) => readFileSync(`supabase/migrations/${f}`, "utf8"))
  .filter((sql) => sql.includes("public.login_events"))
  .join("\n");

describe("Y-6B login events", () => {
  it("C — only login/logout/refresh are allowed event types", () => {
    expect([...LOGIN_EVENT_TYPES]).toEqual(["login", "logout", "refresh"]);
    expect(isAllowedLoginEventType("login")).toBe(true);
    expect(isAllowedLoginEventType("impersonate")).toBe(false);
    expect(isAllowedLoginEventType("")).toBe(false);
    expect(isAllowedLoginEventType(null)).toBe(false);
  });

  it("D — a session start produces at most one login event", () => {
    const seen = new Set<string>();
    const key = sessionKeyOf({ user: { id: "u1" }, expires_at: 111 });
    expect(decideLoginEvent({ eventType: "login", sessionKey: key, seen }).record).toBe(true);
    // rerenders / route changes replay the same callback
    expect(decideLoginEvent({ eventType: "login", sessionKey: key, seen }).record).toBe(false);
    expect(decideLoginEvent({ eventType: "login", sessionKey: key, seen }).record).toBe(false);
    // logout is a distinct signal and still allowed once
    expect(decideLoginEvent({ eventType: "logout", sessionKey: key, seen }).record).toBe(true);
    expect(decideLoginEvent({ eventType: "logout", sessionKey: key, seen }).record).toBe(false);
  });

  it("D — refresh never floods the database from the client", () => {
    const seen = new Set<string>();
    expect(decideLoginEvent({ eventType: "refresh", sessionKey: "u1:1", seen }).record).toBe(false);
  });

  it("M — session key never embeds an access or refresh token", () => {
    const key = sessionKeyOf({
      user: { id: "u1" },
      expires_at: 999,
      access_token: "supersecrettoken",
    });
    expect(key).toBe("u1:999");
    expect(key).not.toContain("supersecrettoken");
  });
});

describe("Y-6B presence", () => {
  const now = new Date("2026-08-29T12:00:00.000Z");

  it("G — online threshold is 2 minutes", () => {
    expect(isOnline(new Date(now.getTime() - 30_000), now)).toBe(true);
    expect(isOnline(new Date(now.getTime() - 119_000), now)).toBe(true);
    expect(isOnline(new Date(now.getTime() - 121_000), now)).toBe(false);
    expect(presenceStatus(null, now)).toBe("offline");
    expect(presenceStatus("not-a-date", now)).toBe("offline");
  });

  it("F — heartbeat is throttled to roughly once per 60 seconds", () => {
    expect(shouldSendHeartbeat(null, 1_000)).toBe(true);
    expect(shouldSendHeartbeat(1_000, 30_000)).toBe(false);
    expect(shouldSendHeartbeat(1_000, 61_000)).toBe(true);
  });
});

describe("Y-6B actor attribution", () => {
  it("I — human actions carry the acting user", () => {
    expect(humanActor("user-1")).toEqual({ actor: "human", actor_user_id: "user-1" });
    expect(humanActor(null)).toEqual({ actor: "human", actor_user_id: null });
  });

  it("J — ai/customer/system attribution logic is untouched", () => {
    const review = readFileSync("src/lib/islamic/review.server.ts", "utf8");
    // only the human branch sets an actor user id
    expect(review).toContain('actor_user_id: args.actor === "human"');
    const webhook = readFileSync("src/routes/api/public/whatsapp.ts", "utf8");
    expect(webhook).toContain('actor: "ai"');
    expect(webhook).toContain('actor: "customer"');
    expect(webhook).not.toContain("actor_user_id");
  });

  it("E/H — presence updates are self-scoped server-side only", () => {
    const fns = readFileSync("src/lib/identity/identity.functions.ts", "utf8");
    // no client-supplied identity anywhere in the presence path
    expect(fns).toContain("touch_presence");
    expect(fns).not.toContain("input.userId");
    expect(fns).not.toContain("input.agencyId");
    expect(fns).toContain("requireSupabaseAuth");
  });

  it("A/B/K/L/M — login event writes are server-controlled and session-derived", () => {
    const fns = readFileSync("src/lib/identity/identity.functions.ts", "utf8");
    expect(fns).toContain("user_id: userId");
    expect(fns).toContain("agency_id: profile?.agency_id ?? null");
    expect(fns).not.toContain("access_token");
    expect(fns).not.toContain("refresh_token");
  });
});

describe("Y-6B RLS / tenant isolation proof (migration SQL)", () => {
  it("A — login events are agency-isolated and platform-owner readable", () => {
    expect(migration).toContain("ALTER TABLE public.login_events ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("agency_id = private.current_agency_id()");
    expect(migration).toContain("private.is_platform_owner(auth.uid())");
  });

  it("B — authenticated users cannot write login events", () => {
    expect(migration).toContain("GRANT SELECT ON public.login_events TO authenticated;");
    expect(migration).not.toMatch(/GRANT[^;]*INSERT[^;]*login_events[^;]*authenticated/);
  });

  it("K/L — platform owner read-only cross-agency policies exist for FOR SELECT only", () => {
    for (const table of ["agencies", "profiles", "user_roles", "activity_log"]) {
      expect(migration).toContain(`ON public.${table} FOR SELECT TO authenticated`);
    }
    expect(migration).not.toMatch(/platform owner[^"]*"\s*\n?\s*ON public\.\w+ FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  it("E — the presence function is self-scoped to auth.uid()", () => {
    expect(migration).toContain("v_uid uuid := auth.uid()");
    expect(migration).toContain("UPDATE public.profiles SET last_seen_at = now() WHERE id = v_uid");
    expect(migration).toContain("interval '55 seconds'");
  });

  it("M — no token/password/secret column is introduced", () => {
    expect(migration).not.toMatch(/access_token|refresh_token|password|secret/i);
  });
});
