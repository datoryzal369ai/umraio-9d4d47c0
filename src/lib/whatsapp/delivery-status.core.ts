export type WhatsappDeliveryStatus = "sent" | "delivered" | "read" | "failed";

const STATUS_RANK: Record<WhatsappDeliveryStatus, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

export function normalizeWhatsappDeliveryStatus(value: string | null | undefined): WhatsappDeliveryStatus | null {
  return value === "sent" || value === "delivered" || value === "read" || value === "failed"
    ? value
    : null;
}

/** Never regress delivered/read rows when callbacks arrive out of order. */
export function shouldApplyWhatsappStatus(
  current: string | null | undefined,
  incoming: WhatsappDeliveryStatus,
): boolean {
  const normalizedCurrent = normalizeWhatsappDeliveryStatus(current);
  if (!normalizedCurrent) return true;
  if (normalizedCurrent === "failed") return false;
  if (incoming === "failed") return true;
  return STATUS_RANK[incoming] >= STATUS_RANK[normalizedCurrent];
}

export function summarizeWhatsappStatusError(error: {
  code?: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
} | null | undefined): string {
  if (!error) return "none";
  const clean = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 240);
  return `code=${clean(error.code)} title=${clean(error.title ?? error.message)} details=${clean(error.error_data?.details)}`;
}