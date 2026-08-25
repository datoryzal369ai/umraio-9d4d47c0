import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Lightweight AI health/config diagnostic.
 * Reports provider/model and whether credentials are configured — never secrets.
 */
export const aiConfigDiagnostic = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { describeAiConfig } = await import("./ai/config.server");
    return describeAiConfig();
  });
