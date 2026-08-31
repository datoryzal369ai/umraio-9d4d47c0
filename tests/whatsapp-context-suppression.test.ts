import { describe, expect, test } from "vitest";

import {
  collectSuppressedTopics,
  countSuppressedOccurrences,
  detectSuppressionDirective,
  redactSuppressedTopics,
  sanitizeHistory,
  suppressionInstruction,
  type ConversationTurn,
} from "../src/lib/topic-suppression.core";
import { detectUmrahIntent, intentAnchorInstruction } from "../src/lib/sales-intent.core";

type Row = { id: string; sender: "customer" | "ai" | "human"; body: string; created_at: string };

const SUPPRESSED = "digitalrenai.com";

function makeConversation(total: number): Row[] {
  const rows: Row[] = [];
  for (let i = 1; i <= total; i += 1) {
    rows.push({
      id: `m${i}`,
      sender: i % 2 === 0 ? "ai" : "customer",
      body: `Perbualan lama nombor ${i} mengenai ${SUPPRESSED} dan hal korporat.`,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    });
  }
  return rows;
}

/** Mirrors loadContext(): DESC + LIMIT 200 from the DB, then reversed in memory. */
function loadNewest200(all: Row[]): Row[] {
  const desc = [...all].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 200);
  return desc.reverse();
}

function toHistory(rows: Row[]): ConversationTurn[] {
  return rows.map((m) => ({
    role: (m.sender === "customer" ? "user" : "assistant") as "user" | "assistant",
    content: m.body,
  }));
}

function appendCustomer(rows: Row[], body: string): Row[] {
  const idx = rows.length + 1;
  return [
    ...rows,
    {
      id: `m${idx}`,
      sender: "customer",
      body,
      created_at: new Date(Date.UTC(2026, 0, 2, 0, idx)).toISOString(),
    },
  ];
}

describe("STEP 6.4A regression — 231-message production conversation", () => {
  const base = makeConversation(200);
  let all = appendCustomer(base, `Remove ${SUPPRESSED} dalam memori sekarang`); // 201
  all = appendCustomer(all, "Salam"); // 202
  all = appendCustomer(all, "2 orang dan disember"); // 203
  while (all.length < 231) all = appendCustomer(all, "Ok terima kasih");
  // keep the newest three meaningful turns at the end
  all = appendCustomer(all, `Remove ${SUPPRESSED} dalam memori sekarang`);
  all = appendCustomer(all, "Salam");
  all = appendCustomer(all, "2 orang dan disember untuk pakej umrah");

  const loaded = loadNewest200(all);
  const suppressed = collectSuppressedTopics(
    loaded.filter((m) => m.sender === "customer").map((m) => m.body),
  );
  const rawHistory = toHistory(loaded.slice(-40));
  const sanitized = sanitizeHistory(rawHistory, suppressed);
  const latest = loaded[loaded.length - 1]!.body;

  test("A. newest 200 messages selected", () => {
    expect(all.length).toBeGreaterThanOrEqual(231);
    expect(loaded.length).toBe(200);
    expect(loaded[loaded.length - 1]!.id).toBe(all[all.length - 1]!.id);
  });

  test("B. messages after 200 are included", () => {
    const ids = new Set(loaded.map((m) => m.id));
    expect(ids.has("m201")).toBe(true);
    expect(ids.has("m202")).toBe(true);
    expect(ids.has("m203")).toBe(true);
  });

  test("C. chronological order restored", () => {
    for (let i = 1; i < loaded.length; i += 1) {
      expect(loaded[i]!.created_at >= loaded[i - 1]!.created_at).toBe(true);
    }
  });

  test("D. suppression directive detected", () => {
    expect(suppressed.length).toBeGreaterThan(0);
    expect(suppressed.some((t) => t.toLowerCase().includes(SUPPRESSED))).toBe(true);
    expect(suppressionInstruction(suppressed)).toBeTruthy();
  });

  test("E. suppressed topic absent from sanitized history", () => {
    expect(countSuppressedOccurrences(sanitized.map((h) => h.content), suppressed)).toBe(0);
  });

  test("F. intent anchor never reintroduces suppressed topic", () => {
    const anchor = intentAnchorInstruction(latest, redactSuppressedTopics(latest, suppressed));
    expect(anchor.toLowerCase()).not.toContain(SUPPRESSED);
    const directiveAnchor = intentAnchorInstruction(
      `Remove ${SUPPRESSED} dalam memori sekarang`,
      redactSuppressedTopics(`Remove ${SUPPRESSED} dalam memori sekarang`, suppressed),
    );
    expect(directiveAnchor.toLowerCase()).not.toContain(SUPPRESSED);
  });

  test("G. '2 orang dan disember' remains available", () => {
    expect(sanitized.some((h) => h.content.includes("2 orang dan disember"))).toBe(true);
  });

  test("H. Umrah intent still detectable", () => {
    expect(detectUmrahIntent(latest)).not.toBeNull();
  });

  test("I. one authoritative suppression state, no duplicate reply inputs", () => {
    const second = collectSuppressedTopics(
      loaded.filter((m) => m.sender === "customer").map((m) => m.body),
    );
    expect(second).toEqual(suppressed);
    const lastTurn = sanitized[sanitized.length - 1]!;
    expect(sanitized.filter((h) => h.content === lastTurn.content).length).toBe(1);
  });
});

describe("STEP 6.4A regression — scenario matrix", () => {
  test("1. short conversation <200 messages keeps everything", () => {
    const rows = makeConversation(20);
    expect(loadNewest200(rows).length).toBe(20);
  });

  test("2. long conversation >200 keeps only newest", () => {
    const rows = makeConversation(400);
    const loaded = loadNewest200(rows);
    expect(loaded[0]!.id).toBe("m201");
    expect(loaded[loaded.length - 1]!.id).toBe("m400");
  });

  test("3/4. suppression directive near 201 and near newest both detected", () => {
    expect(detectSuppressionDirective(`Remove ${SUPPRESSED} dalam memori sekarang`)).toContain(
      SUPPRESSED,
    );
    expect(detectSuppressionDirective(`Jangan bercakap tentang ${SUPPRESSED} lagi!`)).toContain(
      SUPPRESSED,
    );
  });

  test("5-9. post-suppression customer turns keep Umrah behaviour", () => {
    const topics = [SUPPRESSED];
    const cases: Array<[string, boolean]> = [
      ["Salam", false],
      ["Ada pakej umrah tak?", true],
      ["Berapa harga pakej umrah?", true],
      ["Saya nak booking umrah", true],
      ["2 orang dan Disember", false],
    ];
    for (const [msg, expectIntent] of cases) {
      const anchor = intentAnchorInstruction(msg, redactSuppressedTopics(msg, topics));
      expect(anchor.toLowerCase()).not.toContain(SUPPRESSED);
      expect(anchor).toContain(msg);
      expect(detectUmrahIntent(msg) !== null).toBe(expectIntent);
    }
  });

  test("10. normal Umrah conversation without suppression is unchanged", () => {
    const history: ConversationTurn[] = [
      { role: "user", content: "Salam, ada pakej umrah Disember?" },
      { role: "assistant", content: "Waalaikumsalam, ada. Berapa orang?" },
      { role: "user", content: "2 orang, bajet RM8000" },
    ];
    expect(sanitizeHistory(history, [])).toEqual(history);
    const anchor = intentAnchorInstruction("2 orang, bajet RM8000");
    expect(anchor).toContain("2 orang, bajet RM8000");
  });
});
