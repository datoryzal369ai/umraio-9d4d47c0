import { describe, expect, test } from "vitest";

import { analyzeMeetConversation } from "@/lib/meet/b2b-executive.core";
import {
  analyzeConversion,
  buildValueBridge,
  conversionInstruction,
  detectAgencyPsychology,
  detectCommercialIntent,
  deriveConversionEvents,
} from "@/lib/meet/b2b-conversion.core";
import type { DemoMessage } from "@/lib/meet-executive.core";

const v = (content: string): DemoMessage => ({ role: "visitor", content });
const e = (content: string): DemoMessage => ({ role: "executive", content });

function read(...msgs: DemoMessage[]) {
  const intel = analyzeMeetConversation(msgs);
  return { intel, conv: analyzeConversion(intel, msgs) };
}

describe("commercial intent ladder", () => {
  test("no message → NONE", () => {
    expect(detectCommercialIntent([]).level).toBe("NONE");
  });
  test("curiosity is not commitment", () => {
    expect(detectCommercialIntent(["hi"]).level).toBe("CURIOUS");
  });
  test("explanation request → INTERESTED", () => {
    expect(detectCommercialIntent(["boleh explain macam mana sistem ni"]).level).toBe("INTERESTED");
  });
  test("worth-it question → EVALUATING", () => {
    expect(detectCommercialIntent(["worth it ke untuk agency kecil"]).level).toBe("EVALUATING");
  });
  test("price question → COMMERCIAL_INTENT", () => {
    expect(detectCommercialIntent(["berapa harga sebulan?"]).level).toBe("COMMERCIAL_INTENT");
  });
  test("english price question → COMMERCIAL_INTENT", () => {
    expect(detectCommercialIntent(["how much?"]).level).toBe("COMMERCIAL_INTENT");
  });
  test("trial question → TRIAL_READY", () => {
    expect(detectCommercialIntent(["ada free trial?"]).level).toBe("TRIAL_READY");
  });
  test("subscribe question → SUBSCRIPTION_READY", () => {
    expect(detectCommercialIntent(["macam mana nak subscribe"]).level).toBe("SUBSCRIPTION_READY");
  });
});

describe("agency buying psychology", () => {
  test("staff replacement fear detected with evidence and strategy", () => {
    const [s] = detectAgencyPsychology(["AI ni boleh replace staff saya ke?"]).filter(
      (x) => x.key === "FEAR_AI_REPLACES_STAFF",
    );
    expect(s).toBeDefined();
    expect(s!.evidence.length).toBeGreaterThan(0);
    expect(s!.strategy).toContain("capacity");
    expect(s!.confidence).toBeGreaterThan(0.5);
  });
  test("price sensitivity detected", () => {
    expect(detectAgencyPsychology(["macam mahal juga"]).some((s) => s.key === "PRICE_SENSITIVITY")).toBe(true);
  });
  test("scepticism detected", () => {
    expect(detectAgencyPsychology(["betul ke boleh jalan"]).some((s) => s.key === "SCEPTICISM")).toBe(true);
  });
  test("desire for more sales detected", () => {
    expect(detectAgencyPsychology(["sales saya merundum sekarang"]).some((s) => s.key === "DESIRE_MORE_SALES")).toBe(
      true,
    );
  });
  test("desire for 24/7 detected", () => {
    expect(detectAgencyPsychology(["nak ada orang jawab malam pun"]).some((s) => s.key === "DESIRE_24_7")).toBe(true);
  });
  test("nothing invented when nothing said", () => {
    expect(detectAgencyPsychology(["ok"]).length).toBe(0);
  });
  test("repeated signal raises confidence", () => {
    const once = detectAgencyPsychology(["mahal"]).find((s) => s.key === "PRICE_SENSITIVITY")!;
    const twice = detectAgencyPsychology(["mahal", "budget ketat"]).find((s) => s.key === "PRICE_SENSITIVITY")!;
    expect(twice.confidence).toBeGreaterThan(once.confidence);
  });
});

describe("conversion state machine", () => {
  test("empty conversation → AWARENESS", () => {
    expect(analyzeConversion(analyzeMeetConversation([e("hi")]), [e("hi")]).state).toBe("AWARENESS");
  });
  test("first answer → DISCOVERY", () => {
    expect(read(v("hello, saya owner agensi umrah")).conv.state).toBe("DISCOVERY");
  });
  test("stated pain → PAIN_RECOGNISED", () => {
    expect(read(v("staff lambat reply, enquiry tunggu lama")).conv.state).toBe("PAIN_RECOGNISED");
  });
  test("human request overrides everything", () => {
    const { conv } = read(v("berapa harga"), v("saya nak cakap dengan orang sebenar"));
    expect(conv.state).toBe("HUMAN_HANDOFF");
    expect(conv.blocked).toBe(true);
  });
  test("objection takes precedence over discovery", () => {
    const { conv } = read(v("follow up manual je"), v("macam mahal juga"));
    expect(conv.state).toBe("OBJECTION");
    expect(conv.activeObjections).toContain("COST");
  });
  test("trial question → TRIAL_READY", () => {
    expect(read(v("follow up manual"), v("ada free trial?")).conv.state).toBe("TRIAL_READY");
  });
  test("subscribe question → SUBSCRIPTION_READY", () => {
    expect(read(v("macam mana nak subscribe")).conv.state).toBe("SUBSCRIPTION_READY");
  });
  test("state never progresses without evidence", () => {
    expect(read(v("hi"), v("ok")).conv.state).toBe("DISCOVERY");
  });
});

describe("value bridge", () => {
  test("no bridge without an evidenced gap", () => {
    const intel = analyzeMeetConversation([v("hi")]);
    expect(buildValueBridge(intel)).toBeNull();
  });
  test("bridge follows the required structure and invents no figures", () => {
    const intel = analyzeMeetConversation([
      v("kami 3 orang sales"),
      v("enquiry masuk whatsapp tapi staff lambat reply"),
    ]);
    const bridge = buildValueBridge(intel);
    expect(bridge).not.toBeNull();
    const all = Object.values(bridge!).join(" ");
    expect(bridge!.whatUmraioCanDo).toContain("UMRAIO can");
    expect(bridge!.expectedOutcome).toContain("not a guaranteed result");
    expect(all).not.toMatch(/\b\d+\s*%/);
    expect(all.toLowerCase()).not.toContain("roi");
  });
});

describe("prompt instruction + events", () => {
  test("instruction carries state, ethics and anti-chatbot style rules", () => {
    const { conv } = read(v("follow up manual, selalu terlepas"));
    const text = conversionInstruction(conv);
    expect(text).toContain("Conversion state:");
    expect(text).toContain("never invent");
    expect(text).toContain("Thank you for your interest");
  });
  test("no psychology claim when nothing evidenced", () => {
    const { conv } = read(v("ok"));
    expect(conversionInstruction(conv)).toContain("No buying-psychology signal is evidenced yet");
  });
  test("events are derived from real state only", () => {
    const { conv } = read(v("follow up manual"), v("ada free trial?"));
    const events = deriveConversionEvents(conv);
    expect(events).toContain("trial_ready");
    expect(events).toContain("commercial_intent_detected");
    expect(events).not.toContain("subscription_ready");
  });
  test("blocked conversation emits conversion_blocked", () => {
    const { conv } = read(v("stop, jangan hubungi saya lagi"));
    expect(deriveConversionEvents(conv)).toContain("conversion_blocked");
  });
});
