/**
 * UMRAIO® STEP 3E.1 — LIVE CONVERSION HARDENING regression tests.
 *
 * Covers the five live-QA defects deterministically:
 *   1. conversation history > model window is compacted, never rejected
 *   2. asked-question memory
 *   3. BM / English / Manglish register mirroring
 *   4. cold-start consistency (once, then never again)
 *   5. natural Malaysian spoken register guidance
 */

import { describe, expect, test } from "bun:test";

import { analyzeMeetConversation } from "@/lib/meet/b2b-executive.core";
import { analyzeConversion } from "@/lib/meet/b2b-conversion.core";
import { buildSocialProfile } from "@/lib/sales/social-presence.core";
import type { DemoMessage } from "@/lib/meet-executive.core";
import {
  MALAYSIAN_REGISTER_INSTRUCTION,
  MEET_MODEL_TURN_WINDOW,
  buildCarryOver,
  buildQuestionMemory,
  coldStartInstruction,
  compactMeetConversation,
  detectAskedTopics,
  questionMemoryInstruction,
  registerMirrorInstruction,
  resolveMeetRegister,
} from "@/lib/meet/conversation-memory.core";

const v = (content: string): DemoMessage => ({ role: "visitor", content });
const e = (content: string): DemoMessage => ({ role: "executive", content });

function state(msgs: DemoMessage[]) {
  const intel = analyzeMeetConversation(msgs);
  const conversion = analyzeConversion(intel, msgs);
  const social = buildSocialProfile({
    messages: msgs.map((m) => ({
      sender: m.role === "visitor" ? "customer" : "ai",
      body: m.content,
    })),
  });
  return { intel, conversion, social };
}

/** The real 9-turn live QA journey. */
const NINE_TURN: DemoMessage[] = [
  v("Salam, saya nak naikkan sales agency saya."),
  e("Waalaikumsalam. Saya RAIŌ — AI Autonomous Business Executive™ daripada UMRAIO. Boleh saya tahu nama dan panggilan yang selesa?"),
  v("Nama saya Rizal."),
  e("Baik, Rizal. Berapa orang dalam team sales sekarang?"),
  v("Sales saya slow."),
  e("Faham, Rizal. Dalam sebulan, biasanya berapa enquiry WhatsApp masuk?"),
  v("Banyak enquiry tapi team tak sempat follow-up."),
  e("Bila follow-up lambat, enquiry mudah senyap sebelum team sempat layan."),
  v("Saya dah ada CRM."),
  e("Baik. Dalam proses CRM sekarang, bahagian mana masih manual?"),
  v("Mahal juga."),
  e("Saya faham. Yang lebih merisaukan: komitmen bulanan, atau skopnya belum jelas?"),
  v("Saya kena bincang dengan partner."),
  e("Faham. Boleh forward ringkasan ini kepada partner."),
  v("Data customer saya selamat ke?"),
  e("Soalan yang wajar. Data setiap agency diasingkan dan hanya team sendiri boleh lihat."),
  v("Okay, macam mana nak subscribe?"),
];

describe("1 — long conversation compaction (was HTTP 400)", () => {
  test("the 9-turn journey exceeds the model window", () => {
    expect(NINE_TURN.length).toBeGreaterThan(MEET_MODEL_TURN_WINDOW);
  });

  test("compaction returns a usable window instead of failing", () => {
    const c = compactMeetConversation(NINE_TURN);
    expect(c.compacted).toBe(true);
    expect(c.messages.length).toBeLessThanOrEqual(MEET_MODEL_TURN_WINDOW + 1);
    expect(c.messages[0]!.role).toBe("visitor");
    // The latest visitor turn always survives.
    expect(c.messages[c.messages.length - 1]!.content).toContain("subscribe");
  });

  test("short conversations are untouched", () => {
    const short = [v("Salam"), e("Waalaikumsalam.")];
    const c = compactMeetConversation(short);
    expect(c.compacted).toBe(false);
    expect(c.dropped).toBe(0);
    expect(c.messages).toEqual(short);
  });

  test("carry-over preserves identity, facts, objections and intent", () => {
    const { intel, conversion, social } = state(NINE_TURN);
    const c = compactMeetConversation(NINE_TURN);
    const carry = buildCarryOver({ intel, conversion, social, dropped: c.dropped });
    expect(carry).not.toBeNull();
    expect(carry!).toContain("Rizal");
    expect(carry!.toLowerCase()).toContain("never re-ask");
    expect(carry!).toContain("Objections");
    expect(carry!).toContain("Conversion state");
  });

  test("no carry-over when nothing was dropped", () => {
    const { intel, conversion, social } = state([v("Salam")]);
    expect(buildCarryOver({ intel, conversion, social, dropped: 0 })).toBeNull();
  });

  test("high intent still detected across the full 9-turn history", () => {
    const { conversion } = state(NINE_TURN);
    expect(conversion.commercialIntent).toBe("SUBSCRIPTION_READY");
  });

  test("safety gates remain deterministic on long histories", () => {
    const stopped = state([...NINE_TURN, v("Stop, jangan hantar mesej lagi.")]);
    expect(stopped.intel.optedOut).toBe(true);
    const human = state([...NINE_TURN, v("Saya nak cakap dengan orang sebenar.")]);
    expect(human.intel.humanRequested).toBe(true);
  });
});

describe("2 — asked-question memory", () => {
  test("team size asked once is never asked again", () => {
    const msgs = [
      v("Nama saya Rizal."),
      e("Baik, Rizal. Berapa orang dalam team sales sekarang?"),
      v("Banyak enquiry tapi team tak sempat follow-up."),
    ];
    expect(detectAskedTopics(msgs)).toContain("team_size");
    const { intel, social } = state(msgs);
    const mem = buildQuestionMemory(msgs, intel, social);
    expect(mem.asked).toContain("team_size");
    expect(mem.available).not.toContain("team_size");
    const prompt = questionMemoryInstruction(mem);
    expect(prompt).toContain("Do not repeat");
    expect(prompt).toContain("sales team");
  });

  test("answered facts are marked never-ask-again", () => {
    const msgs = [v("Team sales saya 4 orang, enquiry dalam 200 sebulan.")];
    const { intel, social } = state(msgs);
    const mem = buildQuestionMemory(msgs, intel, social);
    expect(mem.answered).toContain("team_size");
    expect(mem.answered).toContain("enquiry_volume");
    expect(questionMemoryInstruction(mem)).toContain("NEVER ask again");
  });

  test("name is remembered as answered", () => {
    const msgs = [v("Nama saya Rizal.")];
    const { intel, social } = state(msgs);
    expect(buildQuestionMemory(msgs, intel, social).answered).toContain("name_address");
  });

  test("only executive questions count as asked", () => {
    expect(detectAskedTopics([v("Berapa orang dalam team anda?")])).toEqual([]);
    expect(detectAskedTopics([e("Team anda tidak perlu berubah.")])).toEqual([]);
  });

  test("sufficient evidence steers away from more discovery", () => {
    const msgs = [
      v("Team sales saya 4 orang."),
      e("Terima kasih. Berapa enquiry sebulan?"),
      v("200 enquiry sebulan tapi team tak sempat follow-up."),
    ];
    const { intel, social } = state(msgs);
    const mem = buildQuestionMemory(msgs, intel, social);
    expect(mem.sufficientEvidence).toBe(true);
    expect(questionMemoryInstruction(mem)).toContain("Prefer diagnosis");
  });

  test("never two questions in one reply", () => {
    const { intel, social } = state([v("Salam")]);
    expect(questionMemoryInstruction(buildQuestionMemory([v("Salam")], intel, social))).toContain(
      "Never ask two questions in one reply",
    );
  });
});

describe("3 — language / register mirroring", () => {
  test("English-led Manglish is not answered in full BM", () => {
    const r = resolveMeetRegister([
      "Actually my team quite ok la, but enquiry banyak sampai tak sempat reply. Can you show me how it works ah?",
    ]);
    expect(r).toBe("MANGLISH_EN_LED");
    const instr = registerMirrorInstruction(r);
    expect(instr).toContain("mainly in natural English");
    expect(instr).toContain("Do NOT reply in full formal Bahasa Melayu");
  });

  test("BM-led Manglish keeps BM with English business terms", () => {
    const r = resolveMeetRegister([
      "Enquiry banyak tapi team saya tak sempat follow up, boleh tolong tak?",
    ]);
    expect(["MANGLISH_BM_LED", "BM"]).toContain(r);
  });

  test("pure BM and pure English are distinguished", () => {
    expect(resolveMeetRegister(["Saya nak naikkan sales agency saya, boleh tolong?"])).toBe("BM");
    expect(resolveMeetRegister(["How would this help my agency close more bookings?"])).toBe(
      "ENGLISH",
    );
  });

  test("business terms stay English and language is never reset", () => {
    const instr = registerMirrorInstruction(resolveMeetRegister(["Sales saya slow."]));
    expect(instr).toContain("enquiry");
    expect(instr).toContain("never reset the conversation");
  });

  test("empty input is UNKNOWN, not a forced language", () => {
    expect(resolveMeetRegister([])).toBe("UNKNOWN");
  });
});

describe("4 — cold-start consistency", () => {
  test("cold start establishes presence before demonstrating", () => {
    const msgs = [v("Salam, saya nak naikkan sales agency saya.")];
    const { social } = state(msgs);
    const instr = coldStartInstruction({ social, visitorTurns: 1, executiveTurns: 0 });
    expect(instr).toContain("COLD START");
    expect(instr).toContain("AI Autonomous Business Executive™");
    expect(instr).toContain("how they prefer to be addressed");
    expect(instr).toContain("Waalaikumsalam");
  });

  test("Manglish cold start without salam still introduces once, without salam", () => {
    const msgs = [v("Hi, can you show me how UMRAIO works ah?")];
    const { social } = state(msgs);
    const instr = coldStartInstruction({ social, visitorTurns: 1, executiveTurns: 0 });
    expect(instr).toContain("COLD START");
    expect(instr).toContain("Do not open with salam if they did not");
    expect(instr).toContain("complete this social opening first");
  });

  test("established conversation never re-greets or re-introduces", () => {
    const { social } = state(NINE_TURN);
    const instr = coldStartInstruction({ social, visitorTurns: 9, executiveTurns: 8 });
    expect(instr).toContain("ESTABLISHED CONVERSATION");
    expect(instr).toContain("Do NOT greet again");
    expect(instr).toContain("do NOT re-introduce yourself");
    expect(instr).not.toContain("COLD START");
  });
});

describe("5 — natural Malaysian spoken register", () => {
  test("awkward live-QA phrases are explicitly banned", () => {
    expect(MALAYSIAN_REGISTER_INSTRUCTION).toContain("membantu melaksanakan tindakan");
    expect(MALAYSIAN_REGISTER_INSTRUCTION).toContain("sempat layani");
    expect(MALAYSIAN_REGISTER_INSTRUCTION).toContain("pengasingan mengikut tenant");
  });

  test("natural alternatives are prescribed", () => {
    expect(MALAYSIAN_REGISTER_INSTRUCTION).toContain("UMRAIO boleh buat tindakan tu");
    expect(MALAYSIAN_REGISTER_INSTRUCTION).toContain("sempat layan");
    expect(MALAYSIAN_REGISTER_INSTRUCTION).toContain("bahagian mana masih manual");
  });

  test("anda is discouraged and no certifications may be invented", () => {
    expect(MALAYSIAN_REGISTER_INSTRUCTION).toContain('"anda"');
    expect(MALAYSIAN_REGISTER_INSTRUCTION).toContain("Never invent certifications");
  });
});
