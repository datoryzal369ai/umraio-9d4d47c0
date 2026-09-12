export type CallQuotationCandidate = {
  quotationNumber: string | null;
  packageName: string | null;
  travelDate: string | null;
  pax: number | null;
};

export type QuotationContinuityHistoryTurn = {
  role: "customer" | "umraio";
  text: string;
};

export type QuotationContinuityResult = {
  reply: string;
  candidate: CallQuotationCandidate | null;
  /** Recognition and quotation selection never authorize private disclosure. */
  privateDataAuthorized: false;
  strategy: "reference" | "single_candidate" | "multiple_candidates" | "relationship_clues" | "handoff";
};

const QUOTATION = /\b(quotation|quote|sebut\s*harga)\b/i;
const NO_REFERENCE =
  /\b(tak|tidak|tiada|takde|tak ada|tak tahu|lupa|don't|do not|no)\b[\s\S]{0,40}\b(nombor|number|quotation|quote|rujukan)\b|\b(nombor|number|rujukan)\b[\s\S]{0,30}\b(tak|tiada|lupa|don't|no)\b/i;
const REFERENCE_LIKE = /\bQ[A-Z0-9][A-Z0-9\-/ ]{2,}\b/i;
const FAILED_RECOVERY = /tak\s+(?:boleh|dapat)\s+semak/i;

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text || null;
}

function normalizeReference(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function safeClue(candidate: CallQuotationCandidate): string | null {
  const packageName = clean(candidate.packageName);
  if (packageName) return `pakej ${packageName}`;
  const travelDate = clean(candidate.travelDate);
  if (travelDate) return `perjalanan ${travelDate}`;
  if (candidate.pax && candidate.pax > 0) return `${candidate.pax} orang`;
  return null;
}

function priorRecoveries(history: QuotationContinuityHistoryTurn[]): number {
  return history.filter(
    (turn) =>
      turn.role === "umraio" &&
      (/(?:tak apa|cuba cara lain)[\s\S]*(?:quotation|rujukan|pakej|perjalanan|jemaah)/i.test(turn.text) ||
        FAILED_RECOVERY.test(turn.text)),
  ).length;
}

/**
 * Deterministic Calling-only quotation continuity. It consumes only already
 * tenant-bound relationship evidence and never returns totals, deposits,
 * stored quotation numbers, links, or any authorization elevation.
 */
export function resolveQuotationContinuity(args: {
  transcript: string;
  history: QuotationContinuityHistoryTurn[];
  recognizedCaller: boolean;
  leadResolved: boolean;
  conversationLinked: boolean;
  candidates: CallQuotationCandidate[];
  packageInterest?: string | null;
  preferredMonth?: string | null;
  pax?: number | null;
}): QuotationContinuityResult | null {
  const transcript = args.transcript.trim();
  const recentAssistant = args.history.filter((turn) => turn.role === "umraio").slice(-2);
  const activeRecovery = recentAssistant.some((turn) =>
    /(?:quotation|rujukan|pakej|perjalanan|jemaah)/i.test(turn.text),
  );
  if (!QUOTATION.test(transcript) && !NO_REFERENCE.test(transcript) && !activeRecovery) return null;

  const transcriptRef = normalizeReference(transcript);
  const matched = args.candidates.find((candidate) => {
    const stored = candidate.quotationNumber ? normalizeReference(candidate.quotationNumber) : "";
    return stored.length >= 4 && transcriptRef.includes(stored);
  });
  if (matched || REFERENCE_LIKE.test(transcript)) {
    return {
      reply: matched
        ? "Baik, saya dah padankan rujukan itu. Apa yang nak diketahui tentang quotation tersebut?"
        : "Saya belum jumpa rujukan itu dalam rekod hubungan ini. Boleh beritahu nama pakej atau bulan perjalanan?",
      candidate: matched ?? null,
      privateDataAuthorized: false,
      strategy: "reference",
    };
  }

  const failures = priorRecoveries(args.history);
  if (failures >= 2) {
    return {
      reply: "Saya tak nak ulang soalan yang sama. Saya boleh minta staf sambung di WhatsApp—nak saya buat begitu?",
      candidate: null,
      privateDataAuthorized: false,
      strategy: "handoff",
    };
  }

  if (args.recognizedCaller && args.leadResolved && (args.conversationLinked || args.candidates.length > 0)) {
    if (args.candidates.length === 1) {
      const candidate = args.candidates[0]!;
      const clue = safeClue(candidate);
      return {
        reply:
          failures === 0
            ? clue
              ? `Tak apa. Saya jumpa satu rekod yang berkaitan dengan WhatsApp kita. Yang untuk ${clue} itu, betul?`
              : "Tak apa. Saya jumpa satu rekod yang berkaitan dengan WhatsApp kita. Itu quotation yang dimaksudkan?"
            : "Kita cuba cara lain—bulan perjalanan atau jumlah jemaah untuk quotation itu berapa?",
        candidate,
        privateDataAuthorized: false,
        strategy: "single_candidate",
      };
    }
    if (args.candidates.length > 1) {
      const clues = Array.from(new Set(args.candidates.map(safeClue).filter((x): x is string => Boolean(x)))).slice(0, 2);
      return {
        reply:
          failures > 0
            ? "Kita cuba cara lain—berapa orang yang akan pergi untuk quotation itu?"
            : clues.length === 2
              ? `Tak apa. Ada lebih daripada satu rekod yang mungkin berkaitan. Yang ${clues[0]} atau ${clues[1]}?`
              : "Tak apa. Ada lebih daripada satu rekod yang mungkin berkaitan. Bulan perjalanan yang mana satu?",
        candidate: null,
        privateDataAuthorized: false,
        strategy: "multiple_candidates",
      };
    }
  }

  const relationshipClue = clean(args.packageInterest) ?? clean(args.preferredMonth);
  if (relationshipClue && failures === 0) {
    return {
      reply: `Tak apa. Kita boleh cari melalui perbualan terdahulu. Yang berkaitan ${relationshipClue} itu, betul?`,
      candidate: null,
      privateDataAuthorized: false,
      strategy: "relationship_clues",
    };
  }
  return {
    reply:
      failures > 0
        ? "Kita cuba cara lain—berapa orang yang akan pergi atau bila tarikhnya?"
        : "Tak apa. Boleh beritahu nama pakej atau bulan perjalanan supaya saya boleh cari rekod yang betul?",
    candidate: null,
    privateDataAuthorized: false,
    strategy: "relationship_clues",
  };
}

export const FORBIDDEN_QUOTATION_RECOVERY = FAILED_RECOVERY;
