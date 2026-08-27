import { describe, expect, it } from "vitest";

import { transitionQuotation } from "@/lib/quotations/quotations.server";

/**
 * Quotation deposit_paid -> booked must confirm the authoritative bookings row
 * exactly once and emit a single `booking_confirmed` conversion event with the
 * correct agency / lead / booking / quotation attribution.
 */
function makeDb(bookingStatus: string) {
  const events: Array<Record<string, unknown>> = [];
  const state = { bookingStatus };

  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let mode: "select" | "update" | "insert" = "select";
      let neqConfirmed = false;

      const chain: Record<string, unknown> = {
        select: () => chain,
        insert: (row: Record<string, unknown>) => {
          mode = "insert";
          if (table === "conversion_events") events.push(row);
          return chain;
        },
        update: (patch: Record<string, unknown>) => {
          // Supabase applies the update only to rows matching the later
          // eq/neq filters, so the mock must not mutate state here — the
          // conditional write is applied in select() once neq() has run.
          mode = "update";
          filters["patch"] = patch;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        neq: (_col: string, val: unknown) => {
          neqConfirmed = state.bookingStatus === val;
          return chain;
        },
        maybeSingle: async () => {
          if (table === "quotations")
            return {
              data: {
                id: "q-1",
                agency_id: "agency-1",
                lead_id: "lead-1",
                status: "deposit_paid",
                total: 10000,
                deposit_amount: 2000,
                balance_amount: 8000,
                package_id: "pkg-1",
                number_of_pilgrims: 2,
              },
              error: null,
            };
          if (table === "leads") return { data: { stage: "proposal" }, error: null };
          return { data: null, error: null };
        },
        single: async () => ({ data: { id: "q-1", status: "booked" }, error: null }),
        then: undefined,
      };

      // bookings update(...).select() must resolve to affected rows.
      if (table === "bookings") {
        chain["select"] = async () => {
          if (mode !== "update" || neqConfirmed) return { data: [], error: null };
          state.bookingStatus = "confirmed";
          return { data: [{ id: "booking-1", lead_id: "lead-1", status: "confirmed" }], error: null };
        };
      }
      if (table === "conversion_events") {
        chain["insert"] = async (row: Record<string, unknown>) => {
          events.push(row);
          return { error: null };
        };
      }
      return chain;
    },
  } as never;

  return { db, events, state };
}

describe("booking_confirmed attribution", () => {
  it("emits booking_confirmed with agency/lead/booking/quotation attribution", async () => {
    const { db, events } = makeDb("deposit_paid");
    await transitionQuotation(db, "agency-1", "q-1", "booked", { actor: "human" });

    const confirmed = events.filter((e) => e["stage"] === "booking_confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      agency_id: "agency-1",
      lead_id: "lead-1",
      booking_id: "booking-1",
      quotation_id: "q-1",
      actor: "human",
    });
  });

  it("does not duplicate the event when the booking is already confirmed", async () => {
    const { db, events } = makeDb("confirmed");
    await transitionQuotation(db, "agency-1", "q-1", "booked", { actor: "human" });
    expect(events.filter((e) => e["stage"] === "booking_confirmed")).toHaveLength(0);
  });
});
