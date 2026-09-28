export type SupportEmailTransportStatus = {
  provider: "resend";
  configured: boolean;
  from: string | null;
};

function config(env: Record<string, string | undefined> = process.env) {
  return {
    apiKey: env["CUSTOMER_CARE_RESEND_API_KEY"]?.trim() ?? "",
    from: env["CUSTOMER_CARE_FROM_EMAIL"]?.trim() ?? "",
  };
}

export function supportEmailTransportStatus(
  env: Record<string, string | undefined> = process.env,
): SupportEmailTransportStatus {
  const value = config(env);
  return {
    provider: "resend",
    configured: Boolean(value.apiKey && value.from),
    from: value.from || null,
  };
}

export async function sendSupportEmail(input: {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}): Promise<{ ok: true; providerMessageId: string | null } | { ok: false; reason: string }> {
  const { apiKey, from } = config();
  if (!apiKey || !from) return { ok: false, reason: "EMAIL_PROVIDER_NOT_CONFIGURED" };
  if (!input.to.trim() || !input.subject.trim() || !input.text.trim()) {
    return { ok: false, reason: "INVALID_EMAIL_REQUEST" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify({
      from,
      to: [input.to.trim()],
      subject: input.subject.trim().slice(0, 500),
      text: input.text.trim().slice(0, 20000),
    }),
  });

  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: `EMAIL_PROVIDER_HTTP_${response.status}` };
  }

  const value: unknown = await response.json().catch(() => null);
  const id =
    value && typeof value === "object" && "id" in value && typeof value.id === "string"
      ? value.id
      : null;
  return { ok: true, providerMessageId: id };
}
