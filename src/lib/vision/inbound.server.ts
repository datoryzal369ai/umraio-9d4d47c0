/**
 * UMRAIO® IMAGE V1 — inbound image → grounded text observation.
 *
 * This is NOT a second brain. It produces a factual description of what the
 * customer sent and hands it to the EXISTING WhatsApp text pipeline (lead →
 * conversation → coalescing → RÉNAIO.CORE™ → AI SALES ELITE™ →
 * sendWhatsappText). Nothing downstream knows the message arrived as an image.
 *
 * Ordering guarantee (callers must preserve it):
 *   C2 idempotency  →  quota  →  media download  →  limits  →  vision  →  meter
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createIntelligenceGateway } from "@/lib/ai/gateway.server";
import { getAiConfig } from "@/lib/ai/config.server";
import { QuotaError, assertQuota, recordUsageEvent } from "@/lib/billing/usage.server";
import { fetchWhatsappMedia } from "@/lib/whatsapp/media.server";

import {
  MAX_IMAGE_BYTES,
  buildImageMessageText,
  checkImageLimits,
  imageFallbackMessageFor,
  isUnreadableDescription,
  normalizeImageMimeType,
  VISION_UNREADABLE_TOKEN,
  type ImageRejection,
} from "./limits.core";

export type ImageIngestResult =
  | { ok: true; text: string; description: string }
  | { ok: false; reason: ImageRejection; customerMessage: string };

function reject(reason: ImageRejection): ImageIngestResult {
  return { ok: false, reason, customerMessage: imageFallbackMessageFor(reason) };
}

const VISION_SYSTEM = [
  "You describe an image a customer sent to an Umrah travel agency on WhatsApp.",
  "Report ONLY what is visibly present: document type, visible text, names, dates,",
  "amounts, references, and the general subject of a photo.",
  "Never guess, never infer intent, never invent text you cannot read.",
  `If the image is unreadable, blurred, blank or you cannot determine its contents, reply with exactly: ${VISION_UNREADABLE_TOKEN}`,
  "Otherwise reply with a concise factual description (max 80 words). No advice, no sales language.",
].join(" ");

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function ingestInboundImage(
  supabase: any,
  args: {
    agencyId: string;
    mediaId: string;
    accessToken: string;
    /** Meta message id — makes usage metering idempotent across replays. */
    providerMessageId: string | null;
    /** Customer caption sent with the image, if any. */
    caption?: string | null;
  },
): Promise<ImageIngestResult> {
  const startedAt = Date.now();
  console.log(`[vision] image_received agency_id=${args.agencyId} media_id=${args.mediaId}`);

  // 1. QUOTA — before any paid work. Images meter on the existing AI task bucket.
  try {
    await assertQuota(supabase, args.agencyId, "ai_task");
    console.log(`[vision] quota_decision=allowed agency_id=${args.agencyId}`);
  } catch (error) {
    if (error instanceof QuotaError) {
      console.log(`[vision] quota_decision=denied kind=${error.kind} agency_id=${args.agencyId}`);
      return reject("quota_exceeded");
    }
    console.error("[vision] quota_decision=error");
    return reject("quota_exceeded");
  }

  // 2. MEDIA — server-side only; token and temporary URL never leave here.
  const media = await fetchWhatsappMedia(args.mediaId, args.accessToken, {
    maxBytes: MAX_IMAGE_BYTES,
    defaultMimeType: "image/jpeg",
    logPrefix: "vision",
  });
  if (!media.ok) {
    console.error(`[vision] media_retrieval=failed reason=${media.reason}`);
    if (media.reason === "too_large") return reject("too_large");
    if (media.reason === "empty_media") return reject("empty_image");
    return reject("media_unavailable");
  }
  console.log(`[vision] media_retrieval=ok bytes=${media.byteLength} mime=${media.mimeType}`);

  // 3. LIMITS — size / type, before the vision call.
  const limits = checkImageLimits({ bytes: media.byteLength, mimeType: media.mimeType });
  if (!limits.ok) {
    console.log(`[vision] image_rejected reason=${limits.reason} bytes=${media.byteLength}`);
    return reject(limits.reason);
  }

  // 4. VISION — through the EXISTING model-agnostic AI gateway.
  const mimeType = normalizeImageMimeType(media.mimeType) || "image/jpeg";
  const dataUrl = `data:${mimeType};base64,${toBase64(media.bytes)}`;
  const gateway = createIntelligenceGateway();
  const caption = (args.caption ?? "").trim();
  const result = await gateway.generate({
    taskType: "entity_extraction",
    taskClass: "fast",
    system: VISION_SYSTEM,
    prompt: "Describe this image.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: caption
              ? `Describe this image. The customer's caption was: ${caption}`
              : "Describe this image.",
          },
          { type: "image", image: dataUrl, mediaType: mimeType },
        ],
      },
    ],
  });

  const model = (() => {
    try {
      return getAiConfig().fastModel;
    } catch {
      return "unknown";
    }
  })();
  const eventKey = `vision:${args.agencyId}:${args.providerMessageId ?? args.mediaId}`;
  const description = (result.data ?? "").trim();
  const usable = result.ok && description.length > 0 && !isUnreadableDescription(description);

  await recordUsageEvent(supabase, {
    agencyId: args.agencyId,
    eventKey,
    category: "ai_task",
    source: "whatsapp",
    worker: "whatsapp_executive",
    model,
    provider: "lovable_ai",
    success: usable,
    latencyMs: Date.now() - startedAt,
    ...(usable ? {} : { meta: { failure: result.error?.code ?? "unreadable" } }),
  });

  if (!usable) {
    // Never fabricate image contents; degrade to an honest ask-to-resend.
    console.error(
      `[vision] vision_failure category=${result.ok ? "unreadable" : (result.error?.code ?? "unavailable")}`,
    );
    return reject("vision_failed");
  }

  console.log(
    `[vision] vision_success chars=${description.length} latency_ms=${Date.now() - startedAt}`,
  );
  return { ok: true, description, text: buildImageMessageText({ description, caption }) };
}
