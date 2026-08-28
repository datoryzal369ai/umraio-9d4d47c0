/**
 * UMRAIO® — P0 RED-2 PACKAGE IDENTITY MATCHING.
 *
 * PURE functions only (no I/O). This module decides whether an existing live
 * quotation actually matches the package the customer explicitly asked for.
 * It NEVER creates, cancels, mutates or re-prices a quotation, and it never
 * changes the one-live-quotation business rule.
 */

import type { ExistingQuotationCard } from "@/lib/sales/whatsapp-presentation.core";

/** Canonical tiers understood across Malay/English wording. */
const TIER_PATTERNS: Array<{ id: string; label: string; re: RegExp }> = [
  { id: "vip", label: "VIP", re: /\bv\.?\s?i\.?\s?p\.?\b/i },
  { id: "executive", label: "Executive", re: /\b(executive|eksekutif)\b/i },
  { id: "premium", label: "Premium", re: /\b(premium|premier)\b/i },
  { id: "economy", label: "Ekonomi", re: /\b(economy|ekonomi|budget|jimat)\b/i },
  { id: "standard", label: "Standard", re: /\b(standard|standar|asas|basic)\b/i },
];

export type PackageIdentity = {
  /** Canonical identity key (tier id, or normalized catalogue name). */
  id: string;
  /** Human label used in customer-facing copy. */
  label: string;
  /** True when it came from the agency package catalogue. */
  fromCatalogue: boolean;
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Tier identity contained in an arbitrary string (package name or message). */
export function tierIdentity(text: string | null | undefined): PackageIdentity | null {
  if (!text) return null;
  for (const tier of TIER_PATTERNS) {
    if (tier.re.test(text)) return { id: tier.id, label: tier.label, fromCatalogue: false };
  }
  return null;
}

/**
 * Explicit package identity requested by the customer. Catalogue names win
 * over hard-coded tiers; the most recent explicit request in the conversation
 * is sticky (a later "Mana quotation?" does not erase it).
 */
export function detectRequestedPackage(
  customerMessages: ReadonlyArray<string | null | undefined>,
  catalogueNames: ReadonlyArray<string | null | undefined> = [],
): PackageIdentity | null {
  const names = catalogueNames
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .filter(Boolean);

  const recent = customerMessages
    .map((m) => (typeof m === "string" ? m.trim() : ""))
    .filter(Boolean)
    .slice(-12);

  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const message = recent[i]!;
    const normalized = normalizeName(message);
    const catalogueHit = names.find((name) => {
      const n = normalizeName(name);
      return n.length > 2 && normalized.includes(n);
    });
    if (catalogueHit) {
      return {
        id: tierIdentity(catalogueHit)?.id ?? normalizeName(catalogueHit),
        label: catalogueHit,
        fromCatalogue: true,
      };
    }
    const tier = tierIdentity(message);
    if (tier) return tier;
  }
  return null;
}

/** True when the requested identity is satisfied by the quoted package name. */
export function packageIdentityMatches(
  requested: PackageIdentity | null,
  quotedPackageName: string | null | undefined,
): boolean {
  if (!requested) return true; // generic request — existing quotation is fine
  if (!quotedPackageName) return false;
  const quotedNorm = normalizeName(quotedPackageName);
  const requestedNorm = normalizeName(requested.label);
  if (requestedNorm && quotedNorm.includes(requestedNorm)) return true;
  const quotedTier = tierIdentity(quotedPackageName);
  if (quotedTier && quotedTier.id === requested.id) return true;
  return false;
}

function rm(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return `RM${value.toLocaleString("en-MY", { maximumFractionDigits: 2 })}`;
}

/**
 * Truthful mismatch reply: shows the quotation that really exists and states
 * plainly that it is NOT the requested package. Never invents price,
 * availability, hotel or dates for the requested package.
 */
export function packageMismatchReply(
  quotation: ExistingQuotationCard,
  requested: PackageIdentity,
): string {
  const bullets: string[] = [];
  if (quotation.packageName) bullets.push(`• *Pakej:* ${quotation.packageName}`);
  if (quotation.pax && quotation.pax > 0) bullets.push(`• *Jemaah:* ${quotation.pax} orang`);
  const total = rm(quotation.totalMyr);
  if (total) bullets.push(`• *Jumlah:* ${total}`);
  if (quotation.quotationNumber) bullets.push(`• *Rujukan:* ${quotation.quotationNumber}`);

  const parts = ["*QUOTATION CHECK*", "", "Dato', saya jumpa quotation sedia ada:"];
  if (bullets.length) parts.push("", ...bullets);
  parts.push(
    "",
    `Tetapi ini bukan pakej *${requested.label}* yang Dato' minta.`,
    "",
    `Saya boleh semak pilihan *${requested.label}* untuk Dato'.`,
  );
  return parts.join("\n");
}

/** Prompt directive used when the live quotation does not match the request. */
export function packageMismatchInstruction(
  quotation: ExistingQuotationCard | null,
  requested: PackageIdentity | null,
): string | null {
  if (!quotation || !requested) return null;
  if (packageIdentityMatches(requested, quotation.packageName)) return null;
  return [
    "PACKAGE IDENTITY MISMATCH:",
    `The customer explicitly asked for *${requested.label}*, but the only live quotation is for "${quotation.packageName ?? "pakej lain"}".`,
    "Never present that quotation as if it satisfies the requested package.",
    "State the existing quotation truthfully, say plainly it is not the requested package, and offer to check the requested package.",
    "Do NOT invent price, hotel, dates or availability for the requested package, and do NOT create, cancel or overwrite the existing quotation.",
  ].join("\n");
}
