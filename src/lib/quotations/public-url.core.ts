/**
 * Public quotation URL resolution (pure).
 *
 * A quotation link is sent to real customers on WhatsApp, so it must point at
 * the public production site. Preview/dev deployment hosts are not usable by a
 * customer, so they are never used as the public base URL.
 */

const DEFAULT_PUBLIC_SITE_URL = "https://umraio.com";

const NON_PUBLIC_HOST = /(^|\.)lovable\.app$|(^|\.)lovableproject\.com$|^localhost$|^127\.0\.0\.1$/i;

export function resolvePublicSiteUrl(raw: string | null | undefined): string {
  const value = (raw ?? "").trim().replace(/\/$/, "");
  if (!value) return DEFAULT_PUBLIC_SITE_URL;
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    return DEFAULT_PUBLIC_SITE_URL;
  }
  if (NON_PUBLIC_HOST.test(host)) return DEFAULT_PUBLIC_SITE_URL;
  return value;
}

export { DEFAULT_PUBLIC_SITE_URL };
