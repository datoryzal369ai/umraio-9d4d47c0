import { describe, expect, it } from "vitest";

import {
  buildEmbeddedSignupLaunchParams,
  isTrustedMetaOrigin,
  parseEmbeddedSignupMessage,
} from "@/lib/whatsapp/embedded-signup.core";

describe("embedded signup launch params", () => {
  it("uses the existing v4 configuration exactly", () => {
    expect(buildEmbeddedSignupLaunchParams()).toEqual({
      config_id: "1417864223589309",
      response_type: "code",
      override_default_response_type: true,
      extras: { version: "v4" },
    });
  });
});

describe("postMessage validation", () => {
  const finish = {
    type: "WA_EMBEDDED_SIGNUP",
    event: "FINISH",
    data: { waba_id: "W1", phone_number_id: "P1" },
  };

  it("accepts a finished session from a Meta origin", () => {
    expect(parseEmbeddedSignupMessage("https://www.facebook.com", finish)).toEqual({
      wabaId: "W1",
      phoneNumberId: "P1",
    });
  });

  it("accepts the JSON string form", () => {
    expect(parseEmbeddedSignupMessage("https://business.facebook.com", JSON.stringify(finish)))
      .toEqual({ wabaId: "W1", phoneNumberId: "P1" });
  });

  it("ignores untrusted origins", () => {
    expect(isTrustedMetaOrigin("https://evil.example")).toBe(false);
    expect(parseEmbeddedSignupMessage("https://evil.example", finish)).toBeNull();
  });

  it("ignores unrelated or incomplete messages", () => {
    expect(parseEmbeddedSignupMessage("https://www.facebook.com", { type: "OTHER" })).toBeNull();
    expect(
      parseEmbeddedSignupMessage("https://www.facebook.com", {
        type: "WA_EMBEDDED_SIGNUP",
        event: "CANCEL",
        data: { waba_id: "W1", phone_number_id: "P1" },
      }),
    ).toBeNull();
    expect(
      parseEmbeddedSignupMessage("https://www.facebook.com", {
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH",
        data: { waba_id: "W1" },
      }),
    ).toBeNull();
    expect(parseEmbeddedSignupMessage("https://www.facebook.com", "not json")).toBeNull();
  });
});
