/**
 * UMRAIO® — deterministic WhatsApp reply composer (pure, no I/O).
 *
 * The model is *asked* to write WhatsApp-native text; this module *guarantees*
 * it at the outbound boundary. It runs once on the final generated reply,
 * immediately before the text is sent to Meta and persisted, so the customer
 * sees exactly what the CRM stores.
 *
 * Two guarantees:
 *  1. COMPOSITION — short paragraphs (typically 1–3 sentences), WhatsApp
 *     `*bold*` (never Markdown `**`, `#` headings or `|` tables), compact
 *     `•` bullets, no wall of text, no stack of repetitive closing questions
 *     or filler offers. Content, figures, honorifics, language register,
 *     references and URLs are never altered.
 *  2. INTERNAL-FAILURE SCRUB — a customer must never be told about credits,
 *     top-ups, quotas, providers, API errors or any other internal condition.
 *     Offending sentences are removed; when nothing customer-safe remains the
 *     composer returns "" so the caller falls back to its normal neutral reply.
 */

/* ------------------------------------------------------------------ */
/* 1. Internal failure disclosure scrub                                 */
/* ------------------------------------------------------------------ */

/**
 * Sentence-level patterns that identify an internal/provider/billing
 * disclosure. Each pattern is deliberately narrow so legitimate Umrah sales
 * language is never touched: "kad kredit" (payment method), "kuota visa /
 * kuota jemaah" (real Umrah quota), "top up bilik" (room surcharge),
 * "penyelenggaraan hotel" and the Malay word "api" (fire) all stay intact.
 */
export const INTERNAL_FAILURE_PATTERNS: RegExp[] = [
  // Credits tied to audio, voice, AI or the system — never "kad kredit"/"credit card".
  /(?<!\bkad\s)\bkredit\b(?!\s+(kad|card)\b)[^.!?\n]{0,40}\b(audio|suara|voice|ai|sistem|system|habis|tidak\s+mencukupi|perlu\s+ditambah|ditambah\s+semula|top.?up|tambah\s+nilai)\b/i,
  /\b(audio|suara|voice|ai|sistem|system)\b[^.!?\n]{0,40}(?<!\bkad\s)\bkredit\b(?!\s+(kad|card)\b)/i,
  /\bcredits?\b(?!\s+cards?\b)[^.!?\n]{0,40}\b(audio|voice|ai|system|insufficient|exhausted|top.?up|replenish|purchase|balance)\b/i,
  /\b(audio|voice|ai|system|insufficient|exhausted|top.?up)\b[^.!?\n]{0,40}\bcredits?\b(?!\s+cards?\b)/i,
  // Top-up / reload of the platform balance (a room "top up" surcharge has no credit/balance noun).
  /\b(top.?up|tambah\s+nilai|tambah\s+semula|isi\s+semula|reload)\b[^.!?\n]{0,30}\b(kredit|credit|baki|balance|akaun|account)\b/i,
  /\b(kredit|credit|baki|balance|akaun|account)\b[^.!?\n]{0,30}\b(top.?up|tambah\s+nilai|tambah\s+semula|isi\s+semula|reload)\b/i,
  // Platform quotas / limits (an Umrah visa or seat quota is never "AI/audio/system" quota).
  /\b(kuota|quota)\s+(ai|audio|suara|voice|sistem|system|mesej|message|api|bulanan\s+ai)\b/i,
  /\b(ai|audio|suara|voice|sistem|system|mesej|message)\s+(kuota|quota)\b/i,
  /\b(had\s+penggunaan|usage\s+limit|rate\s+limit|rate-limited|limit\s+reached)\b/i,
  // Providers, runtimes and transport internals.
  /\b(minimax|openai|chatgpt|gpt-?\d?o?|anthropic|claude|gemini|whisper|xiaozhi|lovable|supabase|cloudflare|wasm|opus|tts|asr|endpoint|webhook|gateway|backend|token|status[_\s]?code|http\s*\d{3})\b/i,
  /\bAPI\b/,
  /\b(error|ralat)\b\s*(code|kod)?\s*[:#]?\s*\d{3,5}\b|\b(kod|code)\s+(ralat|error)\b|\berror\s+code\b/i,
  // Billing / subscription state of the platform (not the customer's booking payment).
  /\b(langganan|subscription|pelan\s+(langganan|bayaran)|billing|pengebilan)\b[^.!?\n]{0,40}\b((?:di)?naik\s+taraf|upgrade|tamat|expired|luput|tidak\s+aktif|inactive|kredit|credit)\b/i,
  /\b((?:di)?naik\s+taraf|upgrade)\b[^.!?\n]{0,40}\b(langganan|subscription|pelan\s+langganan|subscription\s+plan)\b/i,
  // Generic "the system failed" phrasing.
  /\b(ralat|masalah|gangguan|kegagalan|isu)\s+(sistem|teknikal|dalaman)\b|\b(system|technical|internal)\s+(error|failure|issue|problem|fault|glitch)\b/i,
  /\b(sistem|system)\s+(dalam\s+|under\s+)?(penyelenggaraan|maintenance)\b/i,
  /\b(ciri|fungsi|feature|perkhidmatan|service)\s+(suara|audio|voice)\b[^.!?\n]{0,30}\b(tidak\s+(tersedia|aktif|dapat)|unavailable|disabled|dimatikan|belum\s+diaktifkan)\b/i,
];

const LEADING_CONNECTORS =
  /^(namun|walau\s+bagaimanapun|walaubagaimanapun|tetapi|tapi|however|but|nevertheless|nonetheless|meanwhile|sementara\s+itu|selain\s+itu)\b[,\s]*/i;

export function isInternalFailureDisclosure(sentence: string): boolean {
  const value = sentence.trim();
  if (!value) return false;
  return INTERNAL_FAILURE_PATTERNS.some((re) => re.test(value));
}

/* ------------------------------------------------------------------ */
/* 2. Sentence + line primitives                                        */
/* ------------------------------------------------------------------ */

const URL_RE = /https?:\/\/[^\s<>()]+/gi;

/** Splits prose into sentences without breaking URLs, decimals or references. */
export function splitSentences(text: string): string[] {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return [];
  // Split after terminal punctuation that is followed by whitespace and the
  // start of a new sentence (letter, digit, quote, bracket, bold marker, bullet).
  const parts = value.split(/(?<=[.!?…])\s+(?=[\p{L}\p{N}"'(\[*•_])/u);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function isBulletLine(line: string): boolean {
  return /^(\s*)([•\-*–]|\d{1,2}[.)])\s+/.test(line);
}

function isTitleLine(line: string): boolean {
  const value = line.trim();
  return /^\*[^*\n]{1,60}\*:?$/.test(value);
}

function capitalizeFirst(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/* ------------------------------------------------------------------ */
/* 3. Markdown -> WhatsApp                                              */
/* ------------------------------------------------------------------ */

function convertMarkdownTable(lines: string[]): string[] {
  const rows = lines
    .filter((l) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim()),
    );
  if (!rows.length) return [];
  const [header, ...body] = rows;
  if (!body.length) return [`• ${header!.filter(Boolean).join(" — ")}`];
  return body.map((cells) => {
    const label = cells[0] ?? "";
    const rest = cells
      .slice(1)
      .map((c, i) => {
        const h = header![i + 1];
        return h ? `${h} ${c}` : c;
      })
      .filter(Boolean)
      .join(", ");
    return `• *${label}*${rest ? `: ${rest}` : ""}`;
  });
}

/** Rewrites Markdown constructs into WhatsApp-native equivalents. */
export function markdownToWhatsapp(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i] ?? "";
    // Tables: collect the contiguous block.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const block: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) {
        block.push(lines[i] ?? "");
        i += 1;
      }
      i -= 1;
      out.push(...convertMarkdownTable(block));
      continue;
    }
    // Headings -> bold title line.
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      line = `*${heading[1]!.replace(/\*\*/g, "").replace(/^\*|\*$/g, "").trim()}*`;
    }
    // Bold / italic markers.
    line = line.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/__(.+?)__/g, "_$1_");
    // Inline code -> plain.
    line = line.replace(/`([^`]+)`/g, "$1");
    // Markdown bullets -> WhatsApp bullet.
    line = line.replace(/^(\s*)[-*–]\s+/, "$1• ");
    // Horizontal rules -> dropped.
    if (/^\s*([-*_]\s*){3,}$/.test(line)) continue;
    out.push(line.replace(/[ \t]+$/g, ""));
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* 4. Closing filler + repetitive question control                      */
/* ------------------------------------------------------------------ */

/** Generic filler that adds length without a decision for the customer. */
export const GENERIC_CLOSER_PATTERNS: RegExp[] = [
  /^(jika|kalau|sekiranya|if)\b[^.!?]{0,40}\b(apa-apa|sebarang|any)\s+(soalan|pertanyaan|bantuan|maklumat|questions?|help|concerns?)\b/i,
  /\b(jangan\s+(segan|teragak|ragu)|sila\s+(bertanya|hubungi\s+saya)|feel\s+free\s+to|don'?t\s+hesitate|let\s+me\s+know\s+if)\b/i,
  /\b(harap(?:kan)?\s+(?:maklumat\s+)?ini\s+membantu|hope\s+this\s+helps|saya\s+(?:sentiasa\s+)?sedia\s+membantu|happy\s+to\s+help|sedia\s+membantu\s+(?:dato|tuan|puan|encik|cik|anda))\b/i,
  /^(terima\s+kasih\s+(?:kerana|atas)\s+(?:bertanya|pertanyaan|soalan|menghubungi)|thank\s+you\s+for\s+(?:asking|reaching\s+out|your\s+question))\b/i,
];

export function isGenericCloser(sentence: string): boolean {
  const value = sentence.trim();
  if (!value) return false;
  return GENERIC_CLOSER_PATTERNS.some((re) => re.test(value));
}

function isQuestion(sentence: string): boolean {
  return /\?\s*$/.test(sentence.trim());
}

function normalizeForDedupe(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[*_~`]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* 5. Composer                                                          */
/* ------------------------------------------------------------------ */

export type ComposeOptions = {
  /** Maximum sentences per prose paragraph (default 3). */
  maxSentencesPerParagraph?: number;
  /** Soft character budget per prose paragraph before an early break (default 240). */
  maxCharsPerParagraph?: number;
};

export type ComposeResult = {
  text: string;
  /** Sentences removed because they disclosed an internal failure. */
  scrubbedSentences: number;
  /** Trailing duplicate/repetitive questions and filler removed. */
  removedClosers: number;
  /** Whether Markdown constructs were rewritten. */
  markdownRewritten: boolean;
  /** True when the whole reply was unsafe and nothing customer-safe remains. */
  emptyAfterScrub: boolean;
};

type Block =
  | { kind: "prose"; sentences: string[] }
  | { kind: "bullets"; lines: string[] }
  | { kind: "title"; line: string }
  | { kind: "raw"; line: string };

function classifyParagraph(paragraph: string): Block[] {
  const lines = paragraph.split("\n").map((l) => l.replace(/[ \t]+$/g, ""));
  const blocks: Block[] = [];
  let bulletRun: string[] = [];
  const flushBullets = () => {
    if (bulletRun.length) {
      blocks.push({ kind: "bullets", lines: bulletRun });
      bulletRun = [];
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isBulletLine(line)) {
      bulletRun.push(trimmed.replace(/^[-*–]\s+/, "• "));
      continue;
    }
    flushBullets();
    if (isTitleLine(trimmed)) {
      blocks.push({ kind: "title", line: trimmed });
      continue;
    }
    // A bare URL / reference line is kept verbatim on its own line.
    if (/^https?:\/\/\S+$/i.test(trimmed) || /^[A-Z]{1,4}-?\d{2,}[-A-Z0-9]*$/.test(trimmed)) {
      blocks.push({ kind: "raw", line: trimmed });
      continue;
    }
    blocks.push({ kind: "prose", sentences: splitSentences(trimmed) });
  }
  flushBullets();
  return blocks;
}

function chunkSentences(
  sentences: string[],
  maxSentences: number,
  maxChars: number,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const sentence of sentences) {
    const len = sentence.length;
    const wouldOverflow =
      current.length >= maxSentences || (current.length > 0 && currentLen + len > maxChars);
    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(sentence);
    currentLen += len + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Composes the final customer-facing WhatsApp text. Deterministic and
 * idempotent: composing an already-composed reply yields the same string.
 */
export function composeWhatsappReply(input: string | null | undefined, options: ComposeOptions = {}): ComposeResult {
  const maxSentences = Math.max(1, options.maxSentencesPerParagraph ?? 3);
  const maxChars = Math.max(80, options.maxCharsPerParagraph ?? 240);
  const original = (input ?? "").replace(/\r\n?/g, "\n").trim();
  if (!original) {
    return { text: "", scrubbedSentences: 0, removedClosers: 0, markdownRewritten: false, emptyAfterScrub: false };
  }

  const converted = markdownToWhatsapp(original);
  const markdownRewritten = converted !== original;

  const paragraphs = converted
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  let scrubbed = 0;
  let removedClosers = 0;
  const seen = new Set<string>();
  const outBlocks: Block[] = [];

  for (const paragraph of paragraphs) {
    for (const block of classifyParagraph(paragraph)) {
      if (block.kind === "bullets") {
        const kept = block.lines.filter((line) => {
          if (isInternalFailureDisclosure(line)) {
            scrubbed += 1;
            return false;
          }
          return true;
        });
        if (kept.length) outBlocks.push({ kind: "bullets", lines: kept });
        continue;
      }
      if (block.kind === "title" || block.kind === "raw") {
        if (isInternalFailureDisclosure(block.line)) {
          scrubbed += 1;
          continue;
        }
        outBlocks.push(block);
        continue;
      }
      const kept: string[] = [];
      let removedHere = false;
      for (const sentence of block.sentences) {
        if (isInternalFailureDisclosure(sentence)) {
          scrubbed += 1;
          removedHere = true;
          continue;
        }
        if (isGenericCloser(sentence)) {
          removedClosers += 1;
          continue;
        }
        // Only the next retained sentence loses a connector dangling from
        // the disclosure, even when safe sentences preceded that disclosure.
        const withoutConnector = removedHere ? sentence.replace(LEADING_CONNECTORS, "") : sentence;
        const cleaned = withoutConnector !== sentence ? capitalizeFirst(withoutConnector) : sentence;
        const key = normalizeForDedupe(cleaned);
        if (key && seen.has(key)) {
          removedClosers += 1;
          continue;
        }
        if (key) seen.add(key);
        kept.push(cleaned);
        removedHere = false;
      }
      if (kept.length) outBlocks.push({ kind: "prose", sentences: kept });
    }
  }

  // Trailing question stack: keep exactly ONE closing question.
  const last = outBlocks[outBlocks.length - 1];
  if (last && last.kind === "prose") {
    let trailing = 0;
    for (let i = last.sentences.length - 1; i >= 0 && isQuestion(last.sentences[i] ?? ""); i -= 1) trailing += 1;
    if (trailing >= 2) {
      const firstQuestionIdx = last.sentences.length - trailing;
      removedClosers += trailing - 1;
      last.sentences = last.sentences.slice(0, firstQuestionIdx + 1);
    }
  }

  const rendered: string[] = [];
  for (const block of outBlocks) {
    if (block.kind === "prose") {
      for (const chunk of chunkSentences(block.sentences, maxSentences, maxChars)) {
        rendered.push(chunk.join(" "));
      }
    } else if (block.kind === "bullets") {
      rendered.push(block.lines.join("\n"));
    } else {
      rendered.push(block.line);
    }
  }

  // A title line binds to the block that follows it (no blank line between).
  const joined: string[] = [];
  for (let i = 0; i < rendered.length; i += 1) {
    const current = rendered[i]!;
    const next = rendered[i + 1];
    if (isTitleLine(current) && next !== undefined) {
      joined.push(`${current}\n${next}`);
      i += 1;
    } else {
      joined.push(current);
    }
  }

  const text = joined
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text,
    scrubbedSentences: scrubbed,
    removedClosers,
    markdownRewritten,
    emptyAfterScrub: text.length === 0 && scrubbed > 0,
  };
}

/** True when every URL present in `before` is still present verbatim in `after`. */
export function preservesUrls(before: string, after: string): boolean {
  const urls = before.match(URL_RE) ?? [];
  return urls.every((u) => after.includes(u));
}
