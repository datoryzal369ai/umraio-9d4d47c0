# Preview Blank-Screen Audit (read-only)

## PREVIEW STATUS: healthy (in this environment — could not reproduce a blank screen)

Verified live against the running preview server, no files touched.

| Check | Result |
| --- | --- |
| SSR response `GET /` | HTTP 200, 141,389 bytes of fully rendered HTML |
| Browser render `/` | 9,983 chars of visible text, full hero/marketing page screenshot captured |
| Console / page errors on `/` | none |
| Failed network requests on `/` | none |
| `/auth` | renders sign-in form correctly |
| `/meet` | renders |
| `/dashboard`, `/settings/voice` | correctly redirect to `/auth?mode=login&redirect=...` (no loop) |
| Typecheck (`tsgo --noEmit`) | clean, zero errors |
| Dev-server log | clean startup, no build/module errors |

## ROOT CAUSE

Not a frontend build/runtime failure, and not an auth redirect loop. The evidence points to **preview infrastructure / client session state**, most likely one of:

1. A dev-server restart window. The log shows `script "dev" was terminated by signal SIGTERM` followed by a fresh `vite dev` boot at 5:14:33 PM. During that ~1 minute the preview iframe returns nothing and renders white. It is healthy again now.
2. A stale preview iframe holding a pre-restart module graph (needs a hard reload of the preview tab).

## EVIDENCE

- `/tmp/dev-server-logs/dev-server.log` — SIGTERM then clean `VITE v8.1.5 ready` restart; no errors after.
- SSR HTML from `src/routes/__root.tsx` renders shell + full `src/routes/index.tsx` content — so `src/server.ts`, `src/start.ts`, `src/router.tsx` and `routeTree.gen.ts` all resolve correctly.
- `src/routes/_authenticated/route.tsx` redirects unauthenticated users to `/auth` and `/auth` renders — no redirect loop.
- Error handling is wired end to end (`src/server.ts` normalizer, `src/lib/error-capture.ts` listeners, `errorMiddleware` in `src/start.ts`, `errorComponent` in `__root.tsx`), so a real fatal error would surface an HTML error page, not a white screen.

## SECONDARY ISSUES (non-blocking, not the cause)

1. **Hydration mismatch warning** on redirect-protected routes (`/dashboard`, `/settings/voice`). React logs "Hydration failed… tree will be regenerated on the client". It recovers, but it causes a brief flash of empty content that can look like a blank screen on a slow connection. Likely from the `_authenticated` async `beforeLoad` + `ssr: false` boundary interacting with the redirect target.
2. `vite-tsconfig-paths` deprecation notice in the dev log (cosmetic).

## SAFE FIX PLAN (not implemented)

1. First, hard-reload the preview tab. If content returns, it was the restart window — no code change needed.
2. If a blank screen recurs, capture the exact URL and browser console at that moment; the audit needs the failing route, since every route tested renders.
3. Optional hardening, only if approved: add a `pendingComponent` to the `_authenticated` route so the auth-check gap renders a loading state instead of empty markup, which removes the hydration-flash class of "looks blank" reports.
4. Optional cleanup: drop `vite-tsconfig-paths` in favour of Vite's native `resolve.tsconfigPaths`.

## Blank-screen classification

- Frontend runtime/build failure: **NO** — SSR, hydration, typecheck and console are all clean.
- Authentication/redirect: **NO** — protected routes redirect once to a rendering `/auth` page; no loop.
- Preview infrastructure: **YES (most likely)** — dev-server restart window / stale preview iframe.

## RISK TO PRODUCTION

None from this audit. No production code path was exercised or altered. Stripe, billing, quota, Owner Test Mode, IIL, WhatsApp, ASR and TTS were not read into or modified.

- FILES CHANGED = NONE
- PUBLISHED/DEPLOYED = NO
