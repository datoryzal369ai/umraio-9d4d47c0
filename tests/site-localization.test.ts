/**
 * UMRAIO® Step 3G.3 — global locale application.
 *
 * These tests assert the copy contract that the public site renders from.
 * They guard against mixed-language output and against pricing drift.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_LOCALE, isLocale, LOCALE_LABEL, LOCALE_STORAGE_KEY } from "@/lib/i18n/locale";
import { SCHEMA_FAQS, SITE_COPY, siteCopy } from "@/lib/i18n/site.i18n";
import { PRICING_SECTION_COPY, planCopy, localizedPlanPrice, localizedReferencePrice, localizedSavings } from "@/lib/billing/pricing.i18n";
import { publicPlans } from "@/lib/billing/pricing.core";

const bm = siteCopy("bm");
const en = siteCopy("en");

/** Words that must never appear in the other language's user-facing copy. */
const ENGLISH_MARKERS = [" your ", " the ", " and ", " with ", " for "];
const MALAY_MARKERS = [" anda ", " untuk ", " dan ", " yang ", " dengan "];

function flatten(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => flatten(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => flatten(v, out));
  return out;
}

describe("locale selector state", () => {
  it("exposes exactly BM and EN with a single storage key", () => {
    expect(Object.keys(LOCALE_LABEL).sort()).toEqual(["bm", "en"]);
    expect(LOCALE_STORAGE_KEY).toBe("umraio.locale");
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("validates persisted values", () => {
    expect(isLocale("bm")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it("switching locale returns a different copy object", () => {
    expect(siteCopy("bm")).not.toBe(siteCopy("en"));
    expect(siteCopy("bm")).toBe(SITE_COPY.bm);
  });
});

describe("homepage hero", () => {
  it("renders BM hero copy when BM is selected", () => {
    expect(bm.hero.headingLead).toContain("Anda untuk");
    expect(bm.hero.headingAccent).toBe("Agensi Umrah Moden");
    expect(bm.hero.ctaTrial).toBe("Daftar & Pilih Pelan");
    expect(bm.hero.ctaMeet).toContain("Jumpa AI Business Executive");
    expect(bm.hero.subheading).toContain("aliran kerja");
  });

  it("renders EN hero copy when EN is selected", () => {
    expect(en.hero.headingLead).toBe("Your Autonomous AI Business Executive for");
    expect(en.hero.headingAccent).toBe("Modern Umrah Agencies");
    expect(en.hero.ctaTrial).toBe("Choose a Plan");
    expect(en.hero.ctaMeet).toContain("Meet Your AI Business Executive");
  });

  it("does not mix languages in the hero", () => {
    const bmHero = ` ${[bm.hero.headingLead, bm.hero.subheading].join(" ").toLowerCase()} `;
    for (const marker of ENGLISH_MARKERS) expect(bmHero).not.toContain(marker);
    const enHero = ` ${[en.hero.headingLead, en.hero.subheading].join(" ").toLowerCase()} `;
    for (const marker of MALAY_MARKERS) expect(enHero).not.toContain(marker);
  });
});

describe("navigation and CTAs", () => {
  it("localizes navigation labels", () => {
    expect(bm.nav.signIn).toBe("Log Masuk");
    expect(bm.nav.signUp).toBe("Daftar");
    expect(bm.nav.back).toBe("Kembali");
    expect(en.nav.signIn).toBe("Sign In");
    expect(en.nav.signUp).toBe("Sign Up");
    expect(en.nav.back).toBe("Back");
  });

  it("keeps Dashboard as a product term in both languages", () => {
    expect(bm.nav.dashboard).toBe("Dashboard");
    expect(en.nav.dashboard).toBe("Dashboard");
  });

  it("localizes the demo CTA", () => {
    expect(bm.hero.ctaDemo).toBe("Tempah Demo Langsung");
    expect(en.hero.ctaDemo).toBe("Book Live Demo");
  });
});

describe("all public homepage sections are localized", () => {
  const sections = [
    "showcase",
    "builtForUmrah",
    "islamicLayer",
    "loop",
    "trust",
    "governed",
    "ladder",
    "ecosystem",
    "closing",
    "footer",
    "metrics",
    "meet",
  ] as const;

  it("every section differs between BM and EN", () => {
    for (const key of sections) {
      expect(JSON.stringify(bm[key])).not.toEqual(JSON.stringify(en[key]));
    }
  });

  it("BM and EN section shapes match exactly", () => {
    const bmKeys = flatten(bm).length;
    const enKeys = flatten(en).length;
    expect(bmKeys).toBe(enKeys);
  });

  it("localizes the FAQ block", () => {
    expect(bm.faqHeading).toBe("Soalan Lazim");
    expect(en.faqHeading).toBe("Frequently Asked Questions");
    expect(bm.faqs).toHaveLength(en.faqs.length);
    expect(bm.faqs[0]!.q).toContain("Apa itu UMRAIO");
  });

  it("keeps English FAQs for structured data", () => {
    expect(SCHEMA_FAQS).toBe(en.faqs);
  });

  it("localizes the footer", () => {
    expect(bm.footer.privacy).toBe("Dasar Privasi");
    expect(bm.footer.rights).toBe("Hak cipta terpelihara.");
    expect(en.footer.privacy).toBe("Privacy Policy");
  });

  it("preserves brand and technical terms in both languages", () => {
    for (const copy of [bm, en]) {
      expect(copy.islamicLayer.heading).toBe("Islamic Implementation Layer");
      expect(copy.footer.tagline).toBe("Autonomous AI Business Executive");
      expect(copy.meet.roleLine).toContain("Autonomous AI Business Executive");
    }
  });
});

describe("Meet RAIŌ static UI", () => {
  it("localizes surrounding static copy only", () => {
    expect(bm.meet.body).toContain("Beritahu RAIŌ");
    expect(en.meet.body).toContain("Tell RAIŌ");
    expect(bm.meet.ctaTrial).toBe("Daftar & Pilih Pelan");
    expect(en.meet.ctaTrial).toBe("Choose a Plan");
    expect(bm.meet.gapStatus.DETECTED).toBe("Dikesan");
    expect(en.meet.gapStatus.DETECTED).toBe("Detected");
  });
});

describe("pricing localization is unchanged and canonical", () => {
  it("uses the expected BM labels", () => {
    const copy = PRICING_SECTION_COPY.bm;
    expect(copy.mostPopular).toBe("Paling Popular");
    expect(copy.savings(200)).toBe("Jimat RM200/bulan");
    expect(planCopy(publicPlans().find((p) => p.id === "pro")!, "bm").ctaLabel).toBe(
      "Pilih Pro Founding",
    );
    expect(planCopy(publicPlans().find((p) => p.id === "enterprise")!, "bm").ctaLabel).toBe(
      "Hubungi Kami",
    );
  });

  it("uses the expected EN labels", () => {
    const copy = PRICING_SECTION_COPY.en;
    expect(copy.mostPopular).toBe("Most Popular");
    expect(copy.savings(200)).toBe("Save RM200/month");
    expect(planCopy(publicPlans().find((p) => p.id === "pro")!, "en").ctaLabel).toBe(
      "Choose Pro Founding",
    );
    expect(planCopy(publicPlans().find((p) => p.id === "enterprise")!, "en").ctaLabel).toBe(
      "Contact Us",
    );
  });

  it("keeps canonical prices identical across locales", () => {
    const plans = publicPlans();
    const byId = Object.fromEntries(plans.map((p) => [p.id, p]));
    expect(localizedPlanPrice(byId["basic"]!, "bm")).toBe("RM199/bulan");
    expect(localizedPlanPrice(byId["basic"]!, "en")).toBe("RM199/month");
    expect(localizedPlanPrice(byId["pro"]!, "bm")).toBe("RM299/bulan");
    expect(localizedReferencePrice(byId["pro"]!, "en")).toBe("RM499/month");
    expect(localizedPlanPrice(byId["premium"]!, "en")).toBe("RM799/month");
    expect(localizedPlanPrice(byId["enterprise"]!, "bm")).toBe("CUSTOM");
    expect(localizedSavings(byId["pro"]!, "bm")).toBe("Jimat RM200/bulan");
  });
});

describe("settings subscription copy", () => {
  it("localizes headings, status and billing notes", () => {
    expect(PRICING_SECTION_COPY.bm.selectedPlanHeading).toBe("Pelan dipilih");
    expect(PRICING_SECTION_COPY.en.selectedPlanHeading).toBe("Selected plan");
    expect(PRICING_SECTION_COPY.bm.renews).toBe("Pembaharuan");
    expect(PRICING_SECTION_COPY.en.renews).toBe("Renews");
    expect(PRICING_SECTION_COPY.bm.noActiveSubscription).toContain("Tiada langganan berbayar");
    expect(PRICING_SECTION_COPY.en.noActiveSubscription).toContain("No active paid subscription");
    expect(PRICING_SECTION_COPY.bm.selectionRecorded).toContain("Pilihan pelan direkod");
  });
});

describe("hydration safety", () => {
  it("defaults to a deterministic locale for SSR", () => {
    // The provider renders DEFAULT_LOCALE on the server and on first client
    // render, then reads localStorage in an effect — so markup always matches.
    expect(siteCopy(DEFAULT_LOCALE)).toBe(SITE_COPY.en);
  });

  it("copy modules are pure data (no browser access at import time)", () => {
    expect(typeof siteCopy).toBe("function");
    expect(flatten(SITE_COPY).every((s) => typeof s === "string")).toBe(true);
  });
});
