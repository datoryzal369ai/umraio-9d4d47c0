# UMRAIO® — Production Architecture

**Product:** UMRAIO® Autonomous AI Business Executive
**Tagline:** The Autonomous AI Business Executive for Umrah Agencies
**Company:** Digital Renaissance Metaverse

This document describes the architecture as it is actually implemented and deployed.
Brand identity (uploaded UMRAIO® logo, robot AI mark, turquoise/black/white/dark-gray
palette, Sora + Manrope typography) is fixed and must not be redesigned.

---

## 1. Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | TanStack Start v1 (React 19, SSR + file routing) |
| Build | Vite 7, deployed to an edge worker runtime |
| Styling | Tailwind CSS v4 via `src/styles.css`, OKLCH semantic tokens, dark-mode first |
| Components | shadcn/ui primitives in `src/components/ui` |
| Data layer | TanStack Query (30s `staleTime`, route-loader prefetch) |
| Backend | Lovable Cloud (Postgres, Auth, Storage, RLS) |
| Server logic | `createServerFn` (app-internal) + server routes under `src/routes/api` |
| AI | Lovable AI Gateway via the `ai` SDK, tool-calling agent |
| Channels | WhatsApp Cloud API (inbound webhook + outbound send) |
| Charts | Recharts |
| Notifications | sonner |

---

## 2. Folder Structure

```text
src/
  assets/                 official brand assets (logo, robot mark) — do not modify
  components/
    app/                  AppShell, PageHeader, SearchInput, SubmitButton
    brand/                BrandLogo, AssistantAvatar (official identity)
    dashboard/            KpiCard, Charts, AnalyticsCharts
    leads/                LeadBadges, LeadFormDialog
    ui/                   shadcn primitives
  hooks/                  useAuth, use-mobile
  integrations/
    supabase/             generated clients, auth middleware, types
    lovable/              OAuth broker helpers
  lib/                    domain modules (leads, conversations, dashboard,
                          analytics, knowledge, settings, whatsapp)
                          *.server.ts = server-only; *.functions.ts = RPC surface
  routes/
    __root.tsx            shell, head metadata, JSON-LD, providers
    index.tsx             public marketing route
    auth.tsx              login / register / forgot password
    reset-password.tsx    recovery flow
    sitemap[.]xml.ts      generated sitemap
    api/public/whatsapp.ts  signed inbound webhook
    _authenticated/       gated product surface
      route.tsx           integration-managed auth gate (ssr:false)
      dashboard, crm, leads, conversations, analytics,
      knowledge, profile, settings/*
docs/ARCHITECTURE.md
supabase/                 migrations + config
```

Convention: one route file per product surface; shared UI is extracted into
`components/app` once used twice; all data access for a domain lives in one
`src/lib/<domain>.ts` module so routes stay presentational.

---

## 3. Database Schema

Multi-tenant. Every business table carries `agency_id` and is isolated by RLS.

| Table | Purpose |
| --- | --- |
| `agencies` | Tenant root (name, logo, business hours, locale) |
| `profiles` | One per auth user; binds user to `agency_id` (immutable via trigger) |
| `user_roles` | `owner` / `admin` / `agent`, separate table, client-write revoked |
| `agency_settings` | AI personality, language, knowledge behaviour, notifications |
| `packages` | Umrah packages: price, hotels, duration, inclusions |
| `leads` | Contact, source, pipeline stage, temperature (hot/warm/cold), tags |
| `lead_notes` | Free-form notes per lead |
| `conversations` | One thread per lead/channel, AI-autopilot flag |
| `messages` | Inbound/outbound messages, sender = customer / ai / agent |
| `bookings` | Confirmed bookings linked to lead + package |
| `followup_jobs` | Scheduled follow-ups executed by the autonomous executive |
| `knowledge_articles` | FAQ, visa, hotel, travel-guide, PDF-backed content |
| `whatsapp_configs` | Per-agency Meta credentials + verify token |
| `api_keys` | Hashed outbound integration keys (delete restricted) |
| `activity_log` | Append-only audit trail powering all timelines |

Storage buckets: `branding` (private), `knowledge` (private).

**Security model**
- RLS enabled on every public table with explicit `GRANT`s.
- Policies resolve tenancy through a `SECURITY DEFINER` helper in the `private`
  schema; `EXECUTE` is revoked from client roles.
- `profiles.agency_id` and `profiles.id` are immutable (`prevent_profile_tenant_change`).
- Roles are never stored on `profiles`; `has_role()` is the single authority.
- `handle_new_user()` provisions agency + profile + owner role atomically on signup.

---

## 4. Authentication Flow

1. **Register** — email/password or Google (Lovable OAuth broker). The
   `on_auth_user_created` trigger creates the agency, profile and owner role.
2. **Email verification** — Supabase confirmation link; unverified users can sign
   in but see a verification prompt.
3. **Login** — `/auth?mode=login`; session persisted client-side.
4. **Forgot password** — `/auth?mode=forgot` → email link → `/reset-password`.
5. **Protected routes** — everything under `_authenticated/`, gated by the managed
   `ssr:false` layout calling `supabase.auth.getUser()` and redirecting to `/auth`.
6. **Server calls** — `requireSupabaseAuth` middleware validates the bearer token
   attached by `functionMiddleware` in `src/start.ts`; RLS applies as the user.
7. **Profile** — `/profile` for name, phone, job title, password change.
8. **Logout** — cancels in-flight queries, clears the query cache, signs out,
   redirects to `/auth`.

---

## 5. Routing

| Route | Access | Purpose |
| --- | --- | --- |
| `/` | public | Product marketing page |
| `/auth`, `/reset-password` | public | Auth flows |
| `/sitemap.xml` | public | SEO |
| `/api/public/whatsapp` | public (signature-verified) | Inbound WhatsApp webhook |
| `/dashboard` | auth | KPIs, hot leads, activity, follow-ups |
| `/crm` | auth | Drag-and-drop pipeline (New → Completed / Lost) |
| `/leads`, `/leads/$leadId` | auth | Lead CRUD, filters, timeline, notes |
| `/conversations`, `/conversations/$id` | auth | WhatsApp-style AI inbox + sales brief |
| `/analytics` | auth | Conversion, sources, top packages, trends |
| `/knowledge` | auth | Articles, PDFs, AI grounding source |
| `/settings/*` | auth | Agency, AI, WhatsApp, notifications, API keys, subscription |
| `/profile` | auth | User profile |

Each content route defines its own `head()` with unique title, description and
Open Graph tags; `__root.tsx` holds sitewide defaults and JSON-LD only.

---

## 6. AI Executive Architecture

```text
inbound message (WhatsApp webhook | agent UI)
      │
      ▼
sales-ai.functions.ts  (authenticated RPC surface)
      │
      ▼
sales-ai.server.ts  — system prompt assembled from agency_settings
      │  (persona, language, tone, business hours, agency profile)
      ├── tool: search_knowledge     → knowledge_articles (grounding first)
      ├── tool: recommend_packages   → packages
      ├── tool: sync_lead            → leads / lead qualification fields
      └── tool: schedule_followup    → followup_jobs
      ▼
reply persisted to messages → activity_log → optional WhatsApp send
```

Rules: knowledge base is consulted before answering; the agent qualifies before
recommending; every AI action is written to `activity_log`; autopilot can be
disabled per conversation so a human agent takes over.

---

## 7. Component System

- `AppShell` — sidebar + mobile sheet navigation, sign-out block, skip link.
- `BrandLogo` / `AssistantAvatar` — the only permitted brand surfaces; sourced
  from the uploaded official logo asset.
- `PageHeader`, `SearchInput`, `SubmitButton` — shared page primitives
  (SubmitButton keeps an accessible name while pending).
- `KpiCard`, `Charts`, `AnalyticsCharts` — data visualisation.
- `LeadBadges`, `LeadFormDialog` — lead domain UI.
- All colour comes from semantic tokens in `src/styles.css`; no hardcoded colours.
- Glassmorphism + subtle gradients only (`.panel`, `bg-aurora`, `shadow-elevated`).

---

## 8. Non-Functional Standards

- **Responsive** — mobile (single column, sheet nav), tablet, desktop (sidebar).
- **Accessibility** — landmarks, `aria-current`, labelled controls, 44px touch
  targets, visible focus rings, skip-to-content.
- **Performance** — route-loader prefetch, 30s query `staleTime`, code-split
  routes, lazy charts, indexed tenant queries.
- **Reliability** — root error and 404 boundaries, toast-based error surfacing,
  server errors reported through `lovable-error-reporting`.
- **SEO** — per-route metadata, canonical/OG tags, sitemap, robots, JSON-LD.

---

## 9. Future Scalability

1. **Roles & teams** — extend `user_roles` with per-branch scoping; policies
   already route through `has_role()`.
2. **Channels** — the message pipeline is channel-agnostic; Instagram, Messenger,
   web chat and email plug in behind the same `conversations`/`messages` tables.
3. **Autonomous jobs** — `followup_jobs` is a durable queue; a scheduled
   `/api/public/*` endpoint can drain it for cron-driven outreach.
4. **Payments** — `bookings` is the anchor point for deposits and invoicing.
5. **Multi-language** — `agency_settings.language` already steers the AI prompt;
   UI strings can be extracted to a locale layer without schema change.
6. **Analytics depth** — `activity_log` is append-only and can back cohort,
   attribution and agent-performance reporting.
7. **Vector search** — `knowledge_articles` can gain an embedding column and
   switch `search_knowledge` from keyword to semantic retrieval.

---

## 10. Reserved AI Workforce Modules (not implemented)

Navigation slots only, rendered as "Soon" in `AppShell` under the **AI Workforce**
group. No routes, tables or logic exist for them yet:
AI WhatsApp Executive · AI Marketing Executive · AI Content Executive ·
AI Lead Intelligence · AI Quotation Executive · AI Follow-up Executive ·
AI Customer Success Executive · AI Business Insights.
