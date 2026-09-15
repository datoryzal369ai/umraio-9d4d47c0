/**
 * UMRAIO® — public commercial payment entry point.
 *
 * The customer may only choose the payment KIND (deposit or full). The token
 * identifies the quotation; the tenant, lead, booking, currency and ringgit
 * amount are all resolved on the server from authoritative rows. The browser
 * never sees or supplies an amount, and the returned URL confirms nothing —
 * only the verified Stripe webhook can mark money received.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const schema = z.object({
  token: z.string().regex(/^[a-f0-9]{16,64}$/),
  kind: z.enum(["deposit", "full"]),
});

export const PAYMENT_UNAVAILABLE_MESSAGE =
  "Payment cannot be started right now. Please contact the agency.";

export const startQuotationPaymentFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => schema.parse(input))
  .handler(async ({ data }) => {
    // Same hashed-IP gate as the other public quotation endpoints.
    try {
      const { checkPublicQuotationRate, PUBLIC_QUOTATION_RATE_MESSAGE } = await import(
        "@/lib/quotations/public-rate-limit.core"
      );
      const { getRequest } = await import("@tanstack/react-start/server");
      const { clientIpHash } = await import("@/lib/billing/demo-limit.server");
      if (!checkPublicQuotationRate("respond", clientIpHash(getRequest())).allowed) {
        throw new Error(PUBLIC_QUOTATION_RATE_MESSAGE);
      }
    } catch (error) {
      if (error instanceof Error && error.message.length && error.message !== "") {
        // Rate-limit refusals surface; a missing request context fails open.
        const { PUBLIC_QUOTATION_RATE_MESSAGE } = await import(
          "@/lib/quotations/public-rate-limit.core"
        );
        if (error.message === PUBLIC_QUOTATION_RATE_MESSAGE) throw error;
      }
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { startQuotationPayment } = await import("@/lib/payments/payment.server");
    const result = await startQuotationPayment(supabaseAdmin as never, {
      token: data.token,
      kind: data.kind,
    });
    if (!result.ok) throw new Error(PAYMENT_UNAVAILABLE_MESSAGE);
    return { url: result.url, kind: result.kind, amountMyr: result.amountMyr };
  });
