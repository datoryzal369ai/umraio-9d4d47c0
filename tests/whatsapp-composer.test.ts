/**
 * UMRAIO® — WhatsApp reply composition + internal-failure silence.
 *
 * Priority 1 acceptance:
 *  A) outbound text is concise, paragraphed and WhatsApp-native,
 *  B) no customer-facing reply ever discloses credits / quotas / providers /
 *     system failures (the founder's real evidence: "kredit audio ... perlu
 *     ditambah semula"),
 *  C) the composer is wired into the ACTUAL outbound path (generateAgentReply),
 *     so what is sent to Meta is what is stored.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  composeWhatsappReply,
  isGenericCloser,
  isInternalFailureDisclosure,
  markdownToWhatsapp,
  preservesUrls,
  splitSentences,
} from "@/lib/sales/whatsapp-composer.core";
import {
  INTERNAL_FAILURE_SILENCE_INSTRUCTION,
  WHATSAPP_FORMAT_INSTRUCTION,
} from "@/lib/sales/whatsapp-presentation.core";

const paragraphsOf = (text: string) => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

describe("A. concise, human, WhatsApp-native composition", () => {
  it("breaks a wall of text into short paragraphs of at most 3 sentences", () => {
    const wall =
      "Pakej Umrah Ramadan 12 hari bermula RM 8,990 seorang. Hotel di Makkah ialah Swissotel Al Maqam, lima minit ke Masjidil Haram. " +
      "Di Madinah pula Anwar Al Madinah Movenpick. Penerbangan terus Malaysia Airlines dari KLIA. Harga termasuk visa, makan tiga kali sehari dan ziarah. " +
      "Deposit RM 1,000 seorang mengesahkan tempat. Baki boleh dibayar 45 hari sebelum berlepas. Tarikh berlepas 5 Mac 2027.";
    const { text } = composeWhatsappReply(wall);
    const paragraphs = paragraphsOf(text);
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
    for (const p of paragraphs) expect(splitSentences(p).length).toBeLessThanOrEqual(3);
    // Direct answer first — the first sentence is preserved verbatim at the top.
    expect(text.startsWith("Pakej Umrah Ramadan 12 hari bermula RM 8,990 seorang.")).toBe(true);
    // Nothing was lost.
    expect(text).toContain("Tarikh berlepas 5 Mac 2027.");
  });

  it("rewrites Markdown headings, double asterisks, tables and dashes into WhatsApp formatting", () => {
    const md = [
      "## Ringkasan Pakej",
      "Harga **RM 6,990** seorang.",
      "",
      "| Item | Nilai |",
      "|---|---|",
      "| Hotel Makkah | Swissotel |",
      "| Tempoh | 12 hari |",
      "",
      "- Visa termasuk",
      "- Makan 3 kali sehari",
    ].join("\n");
    const { text, markdownRewritten } = composeWhatsappReply(md);
    expect(markdownRewritten).toBe(true);
    expect(text).not.toMatch(/^#/m);
    expect(text).not.toContain("**");
    expect(text).not.toContain("|");
    expect(text).toContain("*Ringkasan Pakej*");
    expect(text).toContain("*RM 6,990*");
    expect(text).toContain("• *Hotel Makkah*: Nilai Swissotel");
    expect(text).toContain("• Visa termasuk");
    expect(text).toContain("• Makan 3 kali sehari");
  });

  it("keeps a bold title line attached to the block it introduces", () => {
    const { text } = composeWhatsappReply("*Harga*\n• Dewasa RM 6,990\n• Kanak-kanak RM 5,500");
    expect(text).toBe("*Harga*\n• Dewasa RM 6,990\n• Kanak-kanak RM 5,500");
  });

  it("removes repetitive closers and keeps exactly one closing question", () => {
    const input =
      "Harga pakej ini RM 6,990 seorang. Deposit RM 1,000. " +
      "Jika ada sebarang soalan, jangan segan untuk bertanya. Saya sedia membantu Dato'. " +
      "Nak saya sediakan sebut harga rasmi? Atau Dato' nak tengok pakej lain dulu? Bila Dato' bercadang untuk berlepas?";
    const { text, removedClosers } = composeWhatsappReply(input);
    expect(removedClosers).toBeGreaterThanOrEqual(4);
    expect(text).not.toMatch(/sebarang soalan/i);
    expect(text).not.toMatch(/sedia membantu/i);
    expect((text.match(/\?/g) ?? []).length).toBe(1);
    expect(text).toContain("Nak saya sediakan sebut harga rasmi?");
  });

  it("drops an exact duplicate sentence", () => {
    const { text, removedClosers } = composeWhatsappReply(
      "Deposit RM 1,000 seorang. Baki 45 hari sebelum berlepas. Deposit RM 1,000 seorang.",
    );
    expect(removedClosers).toBe(1);
    expect(text.match(/Deposit RM 1,000 seorang\./g)).toHaveLength(1);
  });

  it("preserves URLs and reference lines verbatim", () => {
    const input =
      "Sebut harga Dato' sedia. Lihat di sini: https://umraio.com/q/AbC123-xyz?utm=wa.\nQT-2026-0042\nSah sehingga 30 Sep.";
    const { text } = composeWhatsappReply(input);
    expect(preservesUrls(input, text)).toBe(true);
    expect(text).toContain("QT-2026-0042");
  });

  it("is idempotent — composing a composed reply changes nothing", () => {
    const once = composeWhatsappReply(
      "## Harga\nPakej **12 hari** RM 6,990. Termasuk visa dan makan. Deposit RM 1,000.\n\n- Hotel 5 bintang\n- Penerbangan terus\n\nNak saya sediakan sebut harga?",
    ).text;
    expect(composeWhatsappReply(once).text).toBe(once);
  });

  it("returns an empty, non-scrubbed result for empty input", () => {
    expect(composeWhatsappReply("")).toEqual({
      text: "",
      scrubbedSentences: 0,
      removedClosers: 0,
      markdownRewritten: false,
      emptyAfterScrub: false,
    });
  });

  it("classifies filler closers without touching real sales sentences", () => {
    expect(isGenericCloser("Jika ada sebarang soalan, sila bertanya.")).toBe(true);
    expect(isGenericCloser("Feel free to ask if you need anything else.")).toBe(true);
    expect(isGenericCloser("Deposit RM 1,000 mengesahkan tempat Dato'.")).toBe(false);
    expect(isGenericCloser("Nak saya hantar sebut harga sekarang?")).toBe(false);
  });

  it("markdownToWhatsapp leaves already-native WhatsApp text untouched", () => {
    const native = "*Harga*\n• Dewasa RM 6,990\n\nNak saya sediakan sebut harga?";
    expect(markdownToWhatsapp(native)).toBe(native);
  });
});

describe("B. internal failures are never disclosed to the customer", () => {
  const leaks = [
    // The founder's real production evidence (2026-09-07).
    "Maaf Dato', kredit audio saya perlu ditambah semula sebelum saya boleh hantar nota suara.",
    "Kredit suara tidak mencukupi buat masa ini.",
    "Our voice credits are insufficient right now, please try later.",
    "Sistem mengalami ralat teknikal ketika menjana audio.",
    "MiniMax returned an error so I cannot send audio.",
    "Ralat kod 2053 daripada penyedia suara.",
    "The TTS API is currently unavailable.",
    "Kuota AI bulanan agensi telah habis.",
    "Langganan perlu dinaik taraf untuk ciri suara.",
    "Ciri suara tidak tersedia buat masa ini.",
    "Fungsi audio belum diaktifkan untuk akaun ini.",
    "Sila tambah nilai baki akaun untuk teruskan.",
  ];

  it.each(leaks)("flags: %s", (sentence) => {
    expect(isInternalFailureDisclosure(sentence)).toBe(true);
  });

  const legit = [
    "Bayaran boleh dibuat dengan kad kredit atau FPX.",
    "Kuota visa umrah untuk bulan Ramadan sangat terhad.",
    "Top up bilik single RM 800 seorang.",
    "Hotel sedang dalam penyelenggaraan kecil di lobi, bilik tidak terjejas.",
    "Kuota jemaah bas pertama tinggal 4 tempat sahaja.",
    "Baki bayaran RM 5,990 perlu dijelaskan 45 hari sebelum berlepas.",
    "Deposit RM 1,000 mengesahkan tempat Dato'.",
    "Payment by credit card carries no extra charge.",
  ];

  it.each(legit)("keeps legitimate sales language: %s", (sentence) => {
    expect(isInternalFailureDisclosure(sentence)).toBe(false);
  });

  it("scrubs the leaking sentence and keeps the helpful answer around it", () => {
    const input =
      "Pakej Ramadan 12 hari bermula RM 8,990 seorang. " +
      "Maaf Dato', kredit audio saya perlu ditambah semula sebelum saya boleh hantar nota suara. " +
      "Namun, saya boleh terangkan butiran pakej di sini. Nak saya sediakan sebut harga?";
    const { text, scrubbedSentences, emptyAfterScrub } = composeWhatsappReply(input);
    expect(scrubbedSentences).toBe(1);
    expect(emptyAfterScrub).toBe(false);
    expect(text).not.toMatch(/kredit/i);
    expect(text).not.toMatch(/ditambah semula/i);
    expect(text).toContain("Pakej Ramadan 12 hari bermula RM 8,990 seorang.");
    // The dangling contrast connector after the removed sentence is cleaned.
    expect(text).toContain("Saya boleh terangkan butiran pakej di sini.");
    expect(text).toContain("Nak saya sediakan sebut harga?");
  });

  it("scrubs a leaking bullet without dropping the other bullets", () => {
    const { text, scrubbedSentences } = composeWhatsappReply(
      "*Status*\n• Sebut harga sedia\n• Kuota AI habis, audio tidak dapat dihantar\n• Deposit RM 1,000",
    );
    expect(scrubbedSentences).toBe(1);
    expect(text).toContain("• Sebut harga sedia");
    expect(text).toContain("• Deposit RM 1,000");
    expect(text).not.toMatch(/kuota ai/i);
  });

  it("returns an empty, flagged result when the whole reply was a disclosure", () => {
    const { text, emptyAfterScrub, scrubbedSentences } = composeWhatsappReply(
      "Maaf, kredit audio saya perlu ditambah semula. Sistem mengalami ralat teknikal.",
    );
    expect(text).toBe("");
    expect(scrubbedSentences).toBe(2);
    expect(emptyAfterScrub).toBe(true);
  });

  it("the prompt itself forbids disclosure and keeps the concise-format contract", () => {
    expect(INTERNAL_FAILURE_SILENCE_INSTRUCTION).toMatch(/never mention credits/i);
    expect(INTERNAL_FAILURE_SILENCE_INSTRUCTION).toMatch(/voice\/audio feature is unavailable/i);
    expect(WHATSAPP_FORMAT_INSTRUCTION).toMatch(/Direct answer FIRST/);
    expect(WHATSAPP_FORMAT_INSTRUCTION).toMatch(/2-4 short paragraphs/);
    expect(WHATSAPP_FORMAT_INSTRUCTION).toMatch(/exactly ONE next step or question/);
  });
});

describe("C. wired into the actual outbound path", () => {
  const source = readFileSync(new URL("../src/lib/sales-ai.server.ts", import.meta.url), "utf8");

  it("generateAgentReply composes + scrubs the model output before it is returned", () => {
    expect(source).toContain('import { composeWhatsappReply } from "@/lib/sales/whatsapp-composer.core";');
    const composeAt = source.indexOf("const composed = composeWhatsappReply(capabilitySafe);");
    const textAt = source.indexOf("const text = composed.text;");
    const returnAt = source.indexOf("if (text) return text;");
    expect(composeAt).toBeGreaterThan(-1);
    expect(textAt).toBeGreaterThan(composeAt);
    expect(returnAt).toBeGreaterThan(textAt);
  });

  it("the silence instruction is part of the assembled system prompt", () => {
    const formatAt = source.indexOf("    WHATSAPP_FORMAT_INSTRUCTION,\n");
    const silenceAt = source.indexOf("    INTERNAL_FAILURE_SILENCE_INSTRUCTION,\n");
    expect(formatAt).toBeGreaterThan(-1);
    expect(silenceAt).toBe(formatAt + "    WHATSAPP_FORMAT_INSTRUCTION,\n".length);
  });

  it("an all-disclosure completion falls through to the neutral customer-safe reply", () => {
    // Empty composed text reaches `emptyCompletionReply`, never the customer as-is.
    const emptyAt = source.indexOf("return emptyCompletionReply({", source.indexOf("if (text) return text;"));
    expect(emptyAt).toBeGreaterThan(-1);
  });

  it("the webhook sends and stores the same reply object it received from generateAgentReply", () => {
    const route = readFileSync(new URL("../src/routes/api/public/whatsapp.ts", import.meta.url), "utf8");
    expect(route).toContain("generateAgentReply(");
    // No secondary rewrite of `reply` between generation and Meta send/persist.
    expect(route).not.toMatch(/reply\s*=\s*reply\s*\+/);
  });
});
