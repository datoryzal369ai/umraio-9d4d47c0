# AI Quotation Executive™ — Read-Only Readiness Audit

Verdict: **RED at the point of creation.** The quotation chain is fully built, but in production every AI quotation attempt is rejected before a row is written. Confirmed from live telemetry, not inference.

## Confirmed root cause (live evidence)

`activity_log` shows the pattern repeating today (10:25, 10:26, 10:28 UTC and earlier on 26 Aug):

```
TOOL_REQUEST · create_quotation
ACTION_FAILED · create_quotation · rejected
  stage: business_rule
  error: "That package does not belong to this agency."
```

Why: the conversation context loads packages **without an agency filter**
(`src/lib/sales-ai.server.ts:126-134` — `from("packages").eq("is_active", true)` only, run with the server client), while `create_quotation.validate` correctly scopes by agency (`src/lib/sales-ai.server.ts:791-797`). `packages` holds 3 active rows for each of 4 different agencies, so the model routinely picks a package ID belonging to another tenant and the gate rejects it. This is also a cross-tenant data exposure in the prompt context.

Database state: `quotations` total = **1** row ever, 0 with status `sent`; `conversion_events` with a `quotation%` stage = **0**.

So the "AI offers quotation → customer says *Boleh*" case has no working execution path today: the model does call the tool, the tool is rejected, and the model then answers conversationally with no quotation.

## Per-link status

| # | Link | Status | Where |
|---|---|---|---|
| 1 | Buying signal → closing intent | GREEN | `src/lib/sales-intent.core.ts:202`, `src/lib/sales/conversation-intelligence.core.ts:796` — deterministic signal detection injects an explicit closing directive |
| 2 | Closing directive → tool availability | GREEN (registered, always allow-listed via `registry.names()`, `sales-ai.server.ts:1234`) but invocation is model-decided, not deterministic |
| 3 | Required inputs (`package_id`, `pilgrims`) | YELLOW — no deterministic "ask for missing pax/package" step; relies on prompt rules (`sales-ai.server.ts:476`, `:500`) |
| 4 | Creation + authoritative DB write | RED in production / code GREEN — `createQuotation` (`src/lib/quotations/quotations.server.ts:76-160`) is correct: agency-scoped package, deterministic pricing, agency deposit policy, lead → `proposal`, `quotation_created` conversion event. It is simply never reached |
| 5 | Rendering | YELLOW — text only (`renderQuotationMessage`, `:162-190` + public page `/q/$token`). No PDF/image document generation exists |
| 6 | WhatsApp delivery + status | YELLOW/RED — the quotation text rides on the normal AI reply; the quotation row is **never transitioned to `sent`** (only caller of `transitionQuotation` outside the module is the console function `src/lib/quotations.functions.ts:110`). Consequences: no `quotation_sent` conversion event, and `readQuotationByToken` only marks `viewed` when status is `sent` (`:322-337`), so view tracking is dead too |
| 7 | Acceptance → booking | YELLOW — works only via the public link (`respondToQuotationByToken`, `:361-416` → `accepted` → `deposit_pending`; `deposit_paid` creates the booking shell). There is **no WhatsApp-side acceptance path**: a customer replying "Boleh"/"Setuju" in chat changes nothing |
| 8 | booking_confirmed attribution | GREEN — `transitionQuotation` `to === "booked"` confirms the booking exactly once via a conditional update and emits through `recordBookingStatusTransition` (`:295-317`); covered by `tests/booking-confirmed-attribution.test.ts` |
| 9 | Idempotency / failure handling | YELLOW — good: one live quotation per lead, `canTransition` state machine, idempotent booking confirm. Weak: `nextQuotationNumber` uses `count(*)+1` (racy, collision-prone), tool rejections are logged but produce no customer-visible or human-visible recovery |
| 10 | Is it a real worker? | RED — not a worker. `WORKER_KEYS` is `whatsapp, marketing, content, lead_intel` (`src/lib/executive-ai.server.ts:20`); Quotation Executive is listed as `upcoming` in `src/lib/meet-executive.core.ts:297-315` and the sidebar. It is tooling behind AI Sales Executive only |

## Production-ready vs scaffolded

- Production-ready: pricing maths, deposit policy, state machine, booking attribution, public quotation page, console-side quotation actions.
- Blocked by one bug: AI-initiated creation.
- Scaffolded / missing: `sent` transition, delivery-status persistence per quotation, document (PDF) rendering, in-chat acceptance, autonomous worker identity.

## Smallest safe milestone to make it production-ready

1. **Fix tenant scoping (the blocker).** Filter the context package query by `conversation.agency_id` in `sales-ai.server.ts:126`. One-line class of fix; also closes the cross-tenant leak.
2. **Close the delivery loop.** After the quotation message is actually sent on WhatsApp, transition the row `ready → sent` and store the provider message ID, so `quotation_sent`/`quotation_viewed` telemetry works.
3. **Deterministic missing-input request.** When closing intent is detected and package or pax is unknown, emit a fixed clarifying question instead of relying on the model.
4. **In-chat acceptance.** Deterministic acceptance detection on the turn following a `sent` quotation → `accepted` → `deposit_pending` + human notification (no auto-charge, no auto-booking).
5. **Harden numbering.** Replace `count(*)+1` with a per-agency sequence or retry-on-conflict.
6. Optional, later: promote to a real worker key + dashboard card, and PDF rendering.

Steps 1–2 alone convert the known "Boleh" scenario from silent failure to a real, tracked quotation.

## Focused acceptance tests required

- Package context is agency-scoped; a foreign `package_id` is never presented to the model.
- Closing intent + known package + known pax → `create_quotation` executes and writes exactly one row with `quotation_created` event.
- Missing pax → deterministic clarifying question, no quotation row.
- Sent quotation → status `sent`, provider message ID stored, `quotation_sent` event; public view flips to `viewed` once.
- In-chat acceptance → `accepted` → `deposit_pending`, notification raised, no booking and no payment claim.
- Replay of the same acceptance turn emits no duplicate events.
- Existing DNC / current-turn safety and price-truth behaviour unchanged.

## Dependencies / blockers

- None external. No schema change strictly required for steps 1–4 (status/provider-id columns should be verified before step 2).
- Deployment required after the fix — current production carries the failing path.

Nothing was changed. Awaiting approval before any implementation.
