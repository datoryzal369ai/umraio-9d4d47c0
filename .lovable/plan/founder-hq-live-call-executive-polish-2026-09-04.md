# Founder HQ Live Call executive polish

## Scope
Polish only the existing Founder HQ Channel Activity presentation. Keep the P0-C1 data contract, telemetry interpretation, calculations, privacy rules, routing, and all backend/calling/payment behavior unchanged.

## Implementation
- Extract the Live Call row into small presentation components within the Founder HQ page so calls render as full-width responsive cards while WhatsApp text and voice-note activity retain the existing compact table presentation.
- Show the call’s primary facts first: customer, masked phone, agency, operational status, time, duration, and turn count.
- Add concise badges for customer linkage, conversation linkage, memory availability, outcome, language, and closing state.
- Replace the dense evidence block with an accessible expandable “Operational Details” area containing:
  - a five-stage journey using only Received, Meta Accepted, Media Ready, Answered, and Ended evidence;
  - compact identity and memory indicators;
  - outcome, language, closing, duration, termination, and source-state facts;
  - a five-metric performance grid with prominent P50 and secondary P95/sample information;
  - the internal record ID only in technical evidence, with no transcript, summary text, message body, audio, or full phone number.
- Make incomplete and failed journeys immediately scannable using existing semantic status colors and icons; absent metrics display “NO DATA,” while defensive rendering preserves “UNKNOWN” for invalid presentation values.
- Preserve the existing UMRAIO dark navy, cyan/turquoise, typography, and component patterns without changing the rest of Founder HQ.

## Validation
- Run TypeScript checks, the full Vitest suite, and lint for changed files.
- Verify the rendered Founder HQ on desktop and mobile with representative success, partial, failed, unknown, linkage/memory, latency-present, latency-absent/malformed, long-name, and masked-phone states where available.
- Inspect the final diff and confirm no protected backend, database, calling, payment, or infrastructure files changed.
- Do not publish, deploy, merge, or modify production data.
