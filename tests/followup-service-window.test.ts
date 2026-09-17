import { describe, expect, test } from "vitest";

import {
  SERVICE_WINDOW_HOURS,
  withinServiceWindow,
} from "../src/lib/followups/dispatcher.server";

/**
 * WhatsApp 24-hour customer service window.
 *
 * Meta rejects free-form text outside the window (error 131047) AFTER the API
 * has already answered 200, so a follow-up must never be claimed as sent when
 * the customer's last reply is older than the window.
 */
describe("whatsapp service window", () => {
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

  test("open while the customer replied within the window", () => {
    expect(withinServiceWindow(ago(1))).toBe(true);
    expect(withinServiceWindow(ago(SERVICE_WINDOW_HOURS - 0.5))).toBe(true);
  });

  test("closed once the last reply is older than the window", () => {
    expect(withinServiceWindow(ago(SERVICE_WINDOW_HOURS + 0.5))).toBe(false);
    expect(withinServiceWindow(ago(72))).toBe(false);
  });

  test("closed when the customer never replied", () => {
    expect(withinServiceWindow(null)).toBe(false);
    expect(withinServiceWindow(undefined)).toBe(false);
    expect(withinServiceWindow("not-a-date")).toBe(false);
  });
});
