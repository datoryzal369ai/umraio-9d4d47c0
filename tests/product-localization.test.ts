/**
 * UMRAIO® STEP 3G.4 — product-wide BM/EN localization contract.
 *
 * These tests are structural: they guard the single-locale architecture,
 * BM/EN key parity across every app dictionary, protected brand/technical
 * terms, and the requirement that every user-facing surface is wired to
 * the locale system.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import * as accountCopy from "../src/lib/i18n/app/account.i18n";
import * as executiveCopy from "../src/lib/i18n/app/executive.i18n";
import * as leadsCopy from "../src/lib/i18n/app/leads.i18n";
import * as settingsCopy from "../src/lib/i18n/app/settings.i18n";
import * as shellCopy from "../src/lib/i18n/app/shell.i18n";
import * as workspaceCopy from "../src/lib/i18n/app/workspace.i18n";

const MODULES: Record<string, Record<string, unknown>> = {
  account: accountCopy,
  executive: executiveCopy,
  leads: leadsCopy,
  settings: settingsCopy,
  shell: shellCopy,
  workspace: workspaceCopy,
};

type Any = Record<string, unknown>;

function isDict(value: unknown): value is { en: Any; bm: Any } {
  return (
    typeof value === "object" &&
    value !== null &&
    "en" in (value as Any) &&
    "bm" in (value as Any) &&
    typeof (value as Any).en === "object" &&
    typeof (value as Any).bm === "object"
  );
}

/** Flattens a copy tree into dotted key -> "string" | "function" | value. */
function flatten(node: unknown, prefix = "", out: Record<string, unknown> = {}) {
  if (typeof node === "function") {
    out[prefix] = "__fn__";
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return out;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out[prefix] = node;
  return out;
}

const DICTS: Array<{ name: string; en: Any; bm: Any }> = [];
for (const [moduleName, mod] of Object.entries(MODULES)) {
  for (const [exportName, value] of Object.entries(mod)) {
    if (isDict(value)) DICTS.push({ name: `${moduleName}.${exportName}`, en: value.en, bm: value.bm });
  }
}

/** Brand / technical terms that must never be translated. */
const PROTECTED = [
  "UMRAIO",
  "RAIŌ",
  "WhatsApp",
  "CRM",
  "API",
  "Knowledge Base",
  "UMRAVERSE",
  "RÉNAIO.CORE",
];

describe("Step 3G.4 — locale architecture is singular", () => {
  test("exactly one locale context, provider and storage key exist", () => {
    const locale = readFileSync("src/lib/i18n/locale.tsx", "utf8");
    expect(locale.match(/createContext</g)?.length ?? 0).toBe(1);
    expect(locale.match(/export function LocaleProvider/g)?.length ?? 0).toBe(1);
    expect(locale).toContain('LOCALE_STORAGE_KEY = "umraio.locale"');
  });

  test("no app dictionary defines its own locale state or storage", () => {
    for (const file of readdirSync("src/lib/i18n/app")) {
      const source = readFileSync(join("src/lib/i18n/app", file), "utf8");
      expect(source).not.toContain("createContext");
      expect(source).not.toContain("localStorage");
      expect(source).toContain("createDict");
    }
  });

  test("locale is read after hydration so SSR markup matches", () => {
    const locale = readFileSync("src/lib/i18n/locale.tsx", "utf8");
    expect(locale).toContain("useState<Locale>(DEFAULT_LOCALE)");
    expect(locale).toContain("useEffect");
  });
});

describe("Step 3G.4 — BM/EN parity across every product dictionary", () => {
  test("dictionaries were discovered", () => {
    expect(DICTS.length).toBeGreaterThanOrEqual(6);
  });

  for (const dict of DICTS) {
    test(`${dict.name}: identical key structure in BM and EN`, () => {
      const en = flatten(dict.en);
      const bm = flatten(dict.bm);
      expect(Object.keys(bm).sort()).toEqual(Object.keys(en).sort());
    });

    test(`${dict.name}: matching value kinds and no empty BM copy`, () => {
      const en = flatten(dict.en);
      const bm = flatten(dict.bm);
      for (const key of Object.keys(en)) {
        expect(typeof bm[key]).toBe(typeof en[key]);
        if (typeof bm[key] === "string") {
          expect((bm[key] as string).trim().length).toBeGreaterThan(0);
        }
      }
    });

    test(`${dict.name}: protected brand and technical terms survive translation`, () => {
      const en = flatten(dict.en);
      const bm = flatten(dict.bm);
      for (const key of Object.keys(en)) {
        const enValue = en[key];
        if (typeof enValue !== "string") continue;
        for (const term of PROTECTED) {
          if (enValue.includes(term)) {
            expect(bm[key]).toContain(term);
          }
        }
      }
    });

    test(`${dict.name}: BM is a real translation, not an English copy`, () => {
      const en = flatten(dict.en);
      const bm = flatten(dict.bm);
      const translatable = Object.keys(en).filter((key) => {
        const value = en[key];
        return typeof value === "string" && value.trim().split(/\s+/).length >= 3;
      });
      if (translatable.length === 0) return;
      const changed = translatable.filter((key) => bm[key] !== en[key]);
      // Sentence-length copy must be overwhelmingly translated.
      expect(changed.length / translatable.length).toBeGreaterThan(0.7);
    });
  }
});

describe("Step 3G.4 — every user-facing surface consumes the locale", () => {
  const SURFACES = [
    "src/components/app/AppShell.tsx",
    "src/components/dashboard/AnalyticsCharts.tsx",
    "src/components/dashboard/Charts.tsx",
    "src/components/dashboard/WhatsappExecutiveCard.tsx",
    "src/components/executive/ExecutiveCommandPanel.tsx",
    "src/components/executive/OrchestrationPanel.tsx",
    "src/components/executive/SalesOpportunities.tsx",
    "src/components/leads/LeadBadges.tsx",
    "src/components/leads/LeadFormDialog.tsx",
    "src/components/leads/NextBestAction.tsx",
    "src/components/leads/QuotationPanel.tsx",
    "src/components/settings/UsagePanel.tsx",
    "src/routes/auth.tsx",
    "src/routes/reset-password.tsx",
    "src/routes/q.$token.tsx",
    "src/routes/_authenticated/analytics.tsx",
    "src/routes/_authenticated/crm.tsx",
    "src/routes/_authenticated/dashboard.tsx",
    "src/routes/_authenticated/profile.tsx",
    "src/routes/_authenticated/tasks.tsx",
    "src/routes/_authenticated/conversations/index.tsx",
    "src/routes/_authenticated/conversations/$conversationId.tsx",
    "src/routes/_authenticated/executive/index.tsx",
    "src/routes/_authenticated/executive/$workerKey.tsx",
    "src/routes/_authenticated/knowledge/index.tsx",
    "src/routes/_authenticated/leads/index.tsx",
    "src/routes/_authenticated/leads/$leadId.tsx",
    "src/routes/_authenticated/settings/route.tsx",
    "src/routes/_authenticated/settings/agency.tsx",
    "src/routes/_authenticated/settings/ai.tsx",
    "src/routes/_authenticated/settings/api-keys.tsx",
    "src/routes/_authenticated/settings/governance.tsx",
    "src/routes/_authenticated/settings/notifications.tsx",
    "src/routes/_authenticated/settings/subscription.tsx",
    "src/routes/_authenticated/settings/whatsapp.tsx",
  ];

  for (const file of SURFACES) {
    test(`${file} reads copy from the shared locale system`, () => {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("useCopy");
      expect(source).toContain("@/lib/i18n/");
      // No parallel locale plumbing.
      expect(source).not.toContain("localStorage.getItem(\"umraio.locale\")");
    });
  }

  test("the language selector is reachable from the authenticated shell and auth page", () => {
    expect(readFileSync("src/components/app/AppShell.tsx", "utf8")).toContain("LanguageSelector");
    expect(readFileSync("src/routes/auth.tsx", "utf8")).toContain("LanguageSelector");
  });
});
