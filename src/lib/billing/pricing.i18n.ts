/**
 * UMRAIO® — pricing copy localization (Step 3G.2).
 *
 * PRESENTATION ONLY. Prices, plan structure and entitlements stay in
 * src/lib/billing/pricing.core.ts — this module never defines a figure other
 * than by reading the canonical plan it is given.
 */
import type { Locale } from "@/lib/i18n/locale";

import {
  foundingSavings,
  type CanonicalPlan,
  type CanonicalPlanId,
} from "./pricing.core";

type PlanCopy = {
  /** Positioning line under the plan title. */
  subtitle: string;
  ctaLabel: string;
  features: readonly string[];
};

type SectionCopy = {
  eyebrow: string;
  heading: string;
  intro: string;
  mostPopular: string;
  custom: string;
  customNote: string;
  perMonth: string;
  savings: (amount: number) => string;
  noPaymentNote: string;
  availablePlans: string;
  availablePlansNote: string;
  selectedPlan: string;
  currentPlanLabel: string;
  selectedPlanHeading: string;
  selectedPlanNote: string;
  seats: string;
  renews: string;
  noActiveSubscription: string;
  selectionRecorded: string;
  requestActivation: string;
  activationRequested: string;
  checkoutUnavailable: string;
  openingCheckout: string;
  manageBilling: string;
  portalUnavailable: string;
  subscriptionActive: string;
  subscriptionPending: string;
  checkoutSuccess: string;
  checkoutCancelled: string;
  activationNextStep: string;
  connectWhatsapp: string;
};

export const PRICING_SECTION_COPY: Record<Locale, SectionCopy> = {
  bm: {
    eyebrow: "Harga",
    heading: "Harga jelas dan telus",
    intro:
      "Harga bulanan dalam Ringgit Malaysia. Pilih pelan yang paling sesuai untuk agency anda.",
    mostPopular: "Paling Popular",
    custom: "CUSTOM",
    customNote: "Skop dan harga disahkan bersama pasukan UMRAIO.",
    perMonth: "/bulan",
    savings: (amount) => `Jimat RM${amount}/bulan`,
    noPaymentNote:
      "Tiada pemprosesan pembayaran dalam sistem buat masa ini. Memilih pelan tidak bermakna langganan telah aktif atau bayaran telah dibuat.",
    availablePlans: "Pelan tersedia",
    availablePlansNote:
      "Memilih pelan hanya merekod pilihan anda — ia bukan langganan berbayar yang aktif dan tiada bayaran dikutip di sini.",
    selectedPlan: "Pelan dipilih",
    currentPlanLabel: "Pelan semasa",
    selectedPlanHeading: "Pelan dipilih",
    selectedPlanNote:
      "Pelan pilihan dan penggunaan anda. Pengaktifan langganan berbayar disahkan oleh pasukan UMRAIO.",
    seats: "Seats",
    renews: "Pembaharuan",
    noActiveSubscription:
      "Tiada langganan berbayar aktif lagi. Pilih pelan untuk membuat pembayaran.",
    selectionRecorded:
      "Pilihan pelan direkod. Tiada bayaran dikutip — pasukan kami akan sahkan pengaktifan.",
    requestActivation: "Minta Pengaktifan",
    activationRequested:
      "Permintaan pengaktifan direkod. Tiada bayaran dikutip — pasukan UMRAIO akan hubungi anda.",
    checkoutUnavailable:
      "Pembayaran dalam sistem belum tersedia. Permintaan anda direkod dan pasukan kami akan sahkan pengaktifan.",
    openingCheckout: "Membuka pembayaran…",
    manageBilling: "Urus Bil & Pembayaran",
    portalUnavailable:
      "Tiada langganan aktif untuk diurus lagi.",
    subscriptionActive: "Langganan berbayar aktif dan disahkan.",
    subscriptionPending:
      "Pembayaran diterima. Menunggu pengesahan daripada penyedia pembayaran…",
    checkoutSuccess: "Pembayaran berjaya. Mengaktifkan pelan anda…",
    checkoutCancelled: "Pembayaran dibatalkan. Tiada bayaran dikutip.",
    activationNextStep:
      "Pelan anda aktif. Langkah seterusnya: sambungkan WhatsApp dan mulakan perbualan pertama.",
    connectWhatsapp: "Sambung WhatsApp",
  },
  en: {
    eyebrow: "Pricing",
    heading: "Simple, honest pricing",
    intro:
      "Monthly pricing in Malaysian Ringgit. Choose the plan that best fits your agency.",
    mostPopular: "Most Popular",
    custom: "CUSTOM",
    customNote: "Scope and pricing are confirmed with the UMRAIO team.",
    perMonth: "/month",
    savings: (amount) => `Save RM${amount}/month`,
    noPaymentNote:
      "No payment processing exists in the system yet. Choosing a plan does not mean a subscription is active or that a payment has been taken.",
    availablePlans: "Available plans",
    availablePlansNote:
      "Selecting a plan records your selected plan only — it is not an active paid subscription and no payment is taken here.",
    selectedPlan: "Selected plan",
    currentPlanLabel: "Current plan",
    selectedPlanHeading: "Selected plan",
    selectedPlanNote:
      "Your selected plan and usage. Paid subscription activation is confirmed by the UMRAIO team.",
    seats: "Seats",
    renews: "Renews",
    noActiveSubscription: "No active paid subscription yet. Choose a plan to pay and activate.",
    selectionRecorded:
      "Plan selection recorded. No payment has been taken — our team confirms activation.",
    requestActivation: "Request Activation",
    activationRequested:
      "Activation request recorded. No payment has been taken — the UMRAIO team will follow up.",
    checkoutUnavailable:
      "Checkout is not available yet. Your request has been recorded and our team confirms activation.",
    openingCheckout: "Opening checkout…",
    manageBilling: "Manage billing",
    portalUnavailable: "No active subscription to manage yet.",
    subscriptionActive: "Paid subscription active and verified.",
    subscriptionPending: "Payment received. Waiting for the provider to confirm activation…",
    checkoutSuccess: "Payment successful. Activating your plan…",
    checkoutCancelled: "Checkout cancelled. No payment was taken.",
    activationNextStep:
      "Your plan is active. Next: connect WhatsApp and run your first AI conversation.",
    connectWhatsapp: "Connect WhatsApp",
  },
};

const PLAN_COPY: Record<Locale, Record<CanonicalPlanId, PlanCopy>> = {
  bm: {
    basic: {
      subtitle: "Untuk agency yang baru mula",
      ctaLabel: "Pilih Basic",
      features: [
        "1 Nombor WhatsApp",
        "1,500 AI Replies / bulan",
        "300 AI Worker Tasks / bulan",
        "3 Seats",
        "Knowledge Base (50 artikel)",
        "AI Follow-up (berpandu)",
        "Analitik Asas",
      ],
    },
    pro: {
      subtitle: "FOUNDING MEMBER · EARLY ACCESS",
      ctaLabel: "Pilih Pro Founding",
      features: [
        "2 Nombor WhatsApp",
        "5,000 AI Replies / bulan",
        "1,000 AI Worker Tasks / bulan",
        "10 Seats",
        "AI Follow-up automatik & AI Worker",
        "Sebut harga & penjejakan penukaran",
        "Knowledge Base (250 artikel)",
        "Analitik Penuh",
        "Sokongan Keutamaan",
      ],
    },
    premium: {
      subtitle: "Untuk agency yang mahu scale",
      ctaLabel: "Pilih Premium",
      features: [
        "5 Nombor WhatsApp",
        "20,000 AI Replies / bulan",
        "4,000 AI Worker Tasks / bulan",
        "30 Seats",
        "Analitik Lanjutan",
        "Knowledge Base (1,000 artikel)",
        "Akses API",
        "Sokongan Khusus",
      ],
    },
    enterprise: {
      subtitle: "Untuk Agency Group / Multi-Branch",
      ctaLabel: "Hubungi Kami",
      features: [
        "Nombor WhatsApp mengikut keperluan",
        "Had penggunaan AI mengikut keperluan",
        "Kapasiti AI Worker mengikut keperluan",
        "Seats & keupayaan multi-branch",
        "API & Integrasi",
        "Onboarding khusus",
        "Keperluan tadbir urus khusus",
        "Sokongan keutamaan & SLA",
      ],
    },
  },
  en: {
    basic: {
      subtitle: "For agencies getting started",
      ctaLabel: "Choose Basic",
      features: [
        "1 WhatsApp Number",
        "1,500 AI Replies / month",
        "300 AI Worker Tasks / month",
        "3 Seats",
        "Knowledge Base (50 articles)",
        "AI Follow-up (assisted)",
        "Basic Analytics",
      ],
    },
    pro: {
      subtitle: "FOUNDING MEMBER · EARLY ACCESS",
      ctaLabel: "Choose Pro Founding",
      features: [
        "2 WhatsApp Numbers",
        "5,000 AI Replies / month",
        "1,000 AI Worker Tasks / month",
        "10 Seats",
        "Autonomous follow-ups & AI Worker tasks",
        "Quotations & conversion tracking",
        "Knowledge Base (250 articles)",
        "Full Analytics",
        "Priority Support",
      ],
    },
    premium: {
      subtitle: "For agencies ready to scale",
      ctaLabel: "Choose Premium",
      features: [
        "5 WhatsApp Numbers",
        "20,000 AI Replies / month",
        "4,000 AI Worker Tasks / month",
        "30 Seats",
        "Advanced Analytics",
        "Knowledge Base (1,000 articles)",
        "API Access",
        "Dedicated Support",
      ],
    },
    enterprise: {
      subtitle: "For Agency Groups / Multi-Branch",
      ctaLabel: "Contact Us",
      features: [
        "Custom WhatsApp Numbers",
        "Custom AI usage limits",
        "Custom AI Worker capacity",
        "Custom seats & multi-branch capability",
        "API & Integrations",
        "Dedicated onboarding",
        "Custom governance requirements",
        "Priority support & SLA",
      ],
    },
  },
};

export function planCopy(plan: CanonicalPlan, locale: Locale): PlanCopy {
  return PLAN_COPY[locale][plan.id];
}

/** "RM199/bulan" or "RM199/month" — canonical figure, localized suffix. */
export function localizedPlanPrice(plan: CanonicalPlan, locale: Locale): string {
  const copy = PRICING_SECTION_COPY[locale];
  if (plan.priceMyrMonthly === null) return copy.custom;
  return `RM${plan.priceMyrMonthly}${copy.perMonth}`;
}

export function localizedReferencePrice(plan: CanonicalPlan, locale: Locale): string | null {
  if (plan.referencePriceMyrMonthly === null) return null;
  return `RM${plan.referencePriceMyrMonthly}${PRICING_SECTION_COPY[locale].perMonth}`;
}

export function localizedSavings(plan: CanonicalPlan, locale: Locale): string | null {
  const amount = foundingSavings(plan);
  if (amount === null) return null;
  return PRICING_SECTION_COPY[locale].savings(amount);
}
