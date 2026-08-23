/**
 * UMRAIO® VOICE NATURALNESS V2 — deterministic Malay speech normalisation.
 *
 * PURE + DETERMINISTIC. No model, no randomness, no rewriting of meaning.
 * Every function here converts a WRITTEN form into the SPOKEN form of the
 * SAME value. A number, price or date is never rounded, re-ordered or
 * invented — if a value cannot be converted safely it is left untouched.
 */

const ONES = [
  "kosong",
  "satu",
  "dua",
  "tiga",
  "empat",
  "lima",
  "enam",
  "tujuh",
  "lapan",
  "sembilan",
];

export const MALAY_MONTHS = [
  "Januari",
  "Februari",
  "Mac",
  "April",
  "Mei",
  "Jun",
  "Julai",
  "Ogos",
  "September",
  "Oktober",
  "November",
  "Disember",
];

/** Largest value we will speak as words; anything bigger stays as digits. */
export const MAX_SPOKEN_NUMBER = 999_999_999;

/** Integer → Malay words. Returns null when the value is out of safe range. */
export function malayNumber(value: number): string | null {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  if (value > MAX_SPOKEN_NUMBER) return null;
  if (value < 10) return ONES[value]!;
  if (value < 12) return value === 10 ? "sepuluh" : "sebelas";
  if (value < 20) return `${ONES[value - 10]} belas`;
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const rest = value % 10;
    return `${ONES[tens]} puluh${rest ? ` ${ONES[rest]}` : ""}`;
  }
  if (value < 1000) {
    const hundreds = Math.floor(value / 100);
    const rest = value % 100;
    const head = hundreds === 1 ? "seratus" : `${ONES[hundreds]} ratus`;
    return rest ? `${head} ${malayNumber(rest)}` : head;
  }
  if (value < 1_000_000) {
    const thousands = Math.floor(value / 1000);
    const rest = value % 1000;
    const head = thousands === 1 ? "seribu" : `${malayNumber(thousands)} ribu`;
    return rest ? `${head} ${malayNumber(rest)}` : head;
  }
  const millions = Math.floor(value / 1_000_000);
  const rest = value % 1_000_000;
  const head = `${malayNumber(millions)} juta`;
  return rest ? `${head} ${malayNumber(rest)}` : head;
}

/** "5,990.50" → { ringgit: 5990, sen: 50 } — parsing only, never rounding up. */
function parseAmount(raw: string): { ringgit: number; sen: number } | null {
  const cleaned = raw.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [intPart, fracPart] = cleaned.split(".");
  const ringgit = Number(intPart);
  if (!Number.isSafeInteger(ringgit)) return null;
  const sen = fracPart ? Number(fracPart.padEnd(2, "0")) : 0;
  return { ringgit, sen };
}

/** RM5,990 → "lima ribu sembilan ratus sembilan puluh ringgit". */
export function malayCurrency(raw: string): string | null {
  const parsed = parseAmount(raw);
  if (!parsed) return null;
  const ringgitWords = malayNumber(parsed.ringgit);
  if (!ringgitWords) return null;
  const senWords = parsed.sen ? malayNumber(parsed.sen) : null;
  return parsed.sen && senWords
    ? `${ringgitWords} ringgit ${senWords} sen`
    : `${ringgitWords} ringgit`;
}

/** 23/12/2026 or 2026-12-23 → "dua puluh tiga Disember dua ribu dua puluh enam". */
export function malayDate(day: number, month: number, year?: number): string | null {
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const dayWords = malayNumber(day);
  if (!dayWords) return null;
  const base = `${dayWords} ${MALAY_MONTHS[month - 1]}`;
  if (year === undefined) return base;
  const yearWords = malayNumber(year);
  return yearWords ? `${base} ${yearWords}` : base;
}

function malayTime(hour: number, minute: number, meridiem?: string): string | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const h12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const hourWords = malayNumber(h12);
  if (!hourWords) return null;
  const suffix = meridiem
    ? meridiem.toLowerCase().startsWith("a")
      ? " pagi"
      : " petang"
    : hour >= 19
      ? " malam"
      : hour >= 12
        ? " petang"
        : hour >= 5
          ? " pagi"
          : "";
  if (minute === 0) return `pukul ${hourWords}${suffix}`;
  if (minute === 30) return `pukul ${hourWords} setengah${suffix}`;
  return `pukul ${hourWords} ${malayNumber(minute)} minit${suffix}`;
}

/** Phone numbers are spoken digit by digit — never as a huge number. */
function malayDigits(raw: string): string {
  return raw
    .replace(/\D/g, "")
    .split("")
    .map((d) => ONES[Number(d)]!)
    .join(" ");
}

/**
 * Apply every safe normalisation, longest-pattern first so a price inside a
 * date-like string is never mangled. Anything unmatched is left verbatim.
 */
export function normaliseMalaySpeech(text: string): string {
  let out = text;

  // Phone numbers (Malaysian mobile/landline) BEFORE plain numbers.
  out = out.replace(/(?:\+?60|0)1?\d[\d\s-]{6,12}\d/g, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 12) return match;
    return malayDigits(match);
  });

  // Dates: dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd.
  out = out.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (m, y, mo, d) => {
    return malayDate(Number(d), Number(mo), Number(y)) ?? m;
  });
  out = out.replace(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g, (m, d, mo, y) => {
    const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
    return malayDate(Number(d), Number(mo), year) ?? m;
  });

  // Times: 3:30pm, 15:30.
  out = out.replace(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/gi, (m, h, mi, mer) => {
    return malayTime(Number(h), Number(mi), mer as string | undefined) ?? m;
  });

  // Currency: RM5,990 / RM 5,990.50 / 5990 ringgit.
  out = out.replace(/\bRM\s?([\d,]+(?:\.\d{1,2})?)/gi, (m, amount) => {
    return malayCurrency(String(amount)) ?? m;
  });
  out = out.replace(/\b([\d,]+(?:\.\d{1,2})?)\s+ringgit\b/gi, (m, amount) => {
    return malayCurrency(String(amount)) ?? m;
  });

  // Percentages.
  out = out.replace(/\b(\d+(?:\.\d+)?)\s?%/g, (m, num) => {
    const n = Number(num);
    if (!Number.isInteger(n)) return m;
    const words = malayNumber(n);
    return words ? `${words} peratus` : m;
  });

  // Bare integers with thousands separators or plain digits.
  out = out.replace(/\b\d[\d,]*\b/g, (m) => {
    const cleaned = m.replace(/,/g, "");
    if (!/^\d+$/.test(cleaned)) return m;
    const n = Number(cleaned);
    // Years and long codes stay as-is unless they came through a date/price.
    if (cleaned.length > 9) return m;
    const words = malayNumber(n);
    return words ?? m;
  });

  return out.replace(/\s{2,}/g, " ").trim();
}
