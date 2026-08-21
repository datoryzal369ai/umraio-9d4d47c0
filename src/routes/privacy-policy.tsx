import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Shield } from "lucide-react";

import { BrandArchitecture } from "@/components/brand/BrandArchitecture";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/privacy-policy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy | UMRAIO" },
      {
        name: "description",
        content:
          "UMRAIO's Privacy Policy explains how we collect, use, store and protect information for Umrah agencies and their customers.",
      },
      { property: "og:title", content: "Privacy Policy | UMRAIO" },
      {
        property: "og:description",
        content:
          "Read how UMRAIO handles account, business, lead and WhatsApp data for Umrah agencies.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://umraio.com/privacy-policy" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Privacy Policy | UMRAIO" },
      {
        name: "twitter:description",
        content:
          "Read how UMRAIO handles account, business, lead and WhatsApp data for Umrah agencies.",
      },
      { name: "robots", content: "index, follow" },
    ],
    links: [{ rel: "canonical", href: "https://umraio.com/privacy-policy" }],
  }),
  component: PrivacyPolicyPage,
});

function PrivacyPolicyPage() {
  const lastUpdated = "15 August 2026";

  return (
    <div className="relative min-h-dvh overflow-hidden bg-aurora">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid" />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-particles opacity-70" />

      <div className="relative">
        <header className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-5 py-6 sm:px-10 sm:py-8">
          <BrandLogo />
          <Button asChild variant="ghost" className="h-11 rounded-full px-4">
            <Link to="/">
              <ArrowLeft className="mr-1 size-4" aria-hidden />
              Back
            </Link>
          </Button>
        </header>

        <main className="mx-auto w-full max-w-4xl px-5 pb-20 sm:px-10">
          <section className="mx-auto max-w-3xl text-center">
            <span className="animate-rise inline-flex items-center gap-2 rounded-full border border-primary/30 bg-surface/60 px-4 py-1.5 text-[10px] font-light uppercase tracking-[0.28em] text-muted-foreground shadow-[0_0_24px_-12px_var(--color-primary)] backdrop-blur sm:text-[11px]">
              <Shield className="size-3.5 text-primary" />
              Legal
            </span>

            <h1 className="animate-rise mt-8 text-balance text-3xl font-extrabold leading-tight tracking-tight sm:text-5xl">
              Privacy <span className="text-gradient-brand">Policy</span>
            </h1>
            <p className="animate-rise mt-4 text-balance text-sm font-light leading-relaxed text-muted-foreground sm:text-base">
              Last updated: {lastUpdated}
            </p>
          </section>

          <article className="animate-rise mt-12 space-y-8 sm:mt-16">
            <PolicySection title="Introduction">
              <p>
                UMRAIO® (“we”, “us”, or “our”) provides an AI autonomous business executive platform
                for licensed Umrah and travel agencies. This Privacy Policy explains how we collect,
                use, store, share and protect information when you use our website, applications and
                services.
              </p>
              <p>
                By using UMRAIO, you agree to the practices described in this Privacy Policy. If you do
                not agree, please do not use our services.
              </p>
            </PolicySection>

            <PolicySection title="Information We Collect">
              <h3 className="mt-4 text-base font-semibold text-foreground">Account and business information</h3>
              <p>
                When an agency registers for UMRAIO, we collect the information needed to create and
                manage the account. This typically includes the agency name, business contact details,
                administrator email address and any profile information entered during onboarding.
              </p>

              <h3 className="mt-4 text-base font-semibold text-foreground">Customer and lead information entered by agency users</h3>
              <p>
                UMRAIO is a business tool used by agencies to manage their own customer relationships.
                Agency users may enter or import lead and customer information such as names, phone
                numbers, email addresses, cities, travel preferences, group size, budget, travel month
                and conversation history. This data is processed on behalf of the agency that entered it.
              </p>

              <h3 className="mt-4 text-base font-semibold text-foreground">WhatsApp-related information</h3>
              <p>
                If an agency chooses to connect a WhatsApp Business account, we receive and process the
                information necessary to send and receive messages through the WhatsApp platform. This
                includes the connected phone number, WhatsApp Business account identifiers, message
                content, delivery status and any configuration settings the agency provides. We do not
                access personal WhatsApp accounts or messages outside the connected business number.
              </p>

              <h3 className="mt-4 text-base font-semibold text-foreground">Website and app usage data</h3>
              <p>
                We collect technical and usage information needed to operate and improve the platform.
                This may include IP addresses, browser type, device information, pages visited, feature
                usage, error logs and timestamps. Where available, this data is stored in aggregated or
                pseudonymised form.
              </p>

              <h3 className="mt-4 text-base font-semibold text-foreground">Cookies and similar technologies</h3>
              <p>
                UMRAIO uses cookies and similar technologies to maintain sessions, remember preferences,
                understand how the service is used and support security. You can control cookies through
                your browser settings, although disabling certain cookies may affect functionality.
              </p>
            </PolicySection>

            <PolicySection title="How Information Is Used">
              <p>We use the information we collect to:</p>
              <ul className="ml-5 list-disc space-y-1.5 text-muted-foreground">
                <li>Provide, operate and maintain the UMRAIO platform and AI services.</li>
                <li>Enable agency users to manage leads, conversations, tasks and CRM pipelines.</li>
                <li>Generate automated responses, follow-up suggestions and business insights using AI.</li>
                <li>Send and receive WhatsApp messages on behalf of connected agencies.</li>
                <li>Monitor usage, enforce limits and improve platform performance and security.</li>
                <li>Communicate important service updates, billing information and support responses.</li>
              </ul>

              <h3 className="mt-4 text-base font-semibold text-foreground">AI processing and automated responses</h3>
              <p>
                UMRAIO uses AI to read incoming business messages, understand intent, qualify leads,
                suggest replies and recommend next actions. AI outputs are generated for the agency's
                own business purposes and are not used to train third-party AI models. Agencies remain
                responsible for reviewing and approving automated actions where required by their internal
                governance.
              </p>

              <h3 className="mt-4 text-base font-semibold text-foreground">WhatsApp and Meta platform integrations</h3>
              <p>
                When an agency connects WhatsApp, UMRAIO acts as a processor of message data on the
                agency's behalf. Message routing, delivery and status updates are handled through Meta's
                WhatsApp Business Platform and are subject to Meta's terms and data practices. We only
                process the data needed to deliver the service the agency has configured.
              </p>
            </PolicySection>

            <PolicySection title="Third-Party Service Providers">
              <p>
                We rely on carefully selected third-party providers for hosting, authentication, database
                services, AI inference, analytics and messaging infrastructure. These providers only
                receive the information necessary to perform their specific functions and are contractually
                required to protect it. We do not sell personal or business data to third parties.
              </p>
            </PolicySection>

            <PolicySection title="Data Security">
              <p>
                We implement technical and organisational measures designed to protect information from
                unauthorised access, loss or misuse. These include encryption in transit, access controls,
                audit logging and regular security reviews. No online service can guarantee absolute
                security, and agencies are also responsible for maintaining the confidentiality of their
                own account credentials.
              </p>
            </PolicySection>

            <PolicySection title="Data Retention">
              <p>
                We retain information for as long as necessary to provide the service, comply with legal
                obligations, resolve disputes and enforce agreements. Specific retention periods depend on
                the type of data and the agency's subscription status. When data is no longer needed,
                it is securely deleted or anonymised in accordance with our retention procedures.
              </p>
            </PolicySection>

            <PolicySection title="Data Sharing and Disclosure">
              <p>
                We do not share agency or customer data except in the limited circumstances described
                below:
              </p>
              <ul className="ml-5 list-disc space-y-1.5 text-muted-foreground">
                <li>
                  <strong className="text-foreground">With the agency that owns the data.</strong>{" "}
                  Agency users can access the data they or their team members have entered.
                </li>
                <li>
                  <strong className="text-foreground">With service providers.</strong> As described
                  above, for hosting, messaging, AI and operational support.
                </li>
                <li>
                  <strong className="text-foreground">For legal reasons.</strong> When required by law,
                  regulation, legal process or to protect our rights, users or the public.
                </li>
                <li>
                  <strong className="text-foreground">With consent.</strong> When the agency or end-user
                  has given explicit permission.
                </li>
              </ul>
            </PolicySection>

            <PolicySection title="Your Rights">
              <p>
                Depending on your location and applicable law, you may have rights to access, correct,
                restrict or delete your personal information. Agency administrators can manage most
                account and team data directly within UMRAIO. If you are an end-customer of an agency
                using UMRAIO, please contact that agency first, as they control the data they have
                entered about you.
              </p>
            </PolicySection>

            <PolicySection title="Account and Data Deletion Requests">
              <p>
                Agency administrators can request deletion of their account and associated data by
                contacting our support team. We will verify the request and process deletion in a
                reasonable timeframe, subject to any legal or contractual obligations that require us
                to retain certain records.
              </p>
              <p>
                To request deletion of your data, please email us at{" "}
                <a
                  href="mailto:privacy@umraio.com"
                  className="text-primary underline underline-offset-4 transition-colors hover:text-primary-glow"
                >
                  privacy@umraio.com
                </a>{" "}
                with the subject line “Data Deletion Request” and include the email address associated
                with the account.
              </p>
            </PolicySection>

            <PolicySection title="Children's Privacy">
              <p>
                UMRAIO is a business platform intended for use by licensed travel agencies and their
                staff. We do not knowingly collect personal information from children under the age of 16.
                If you believe we have inadvertently collected such information, please contact us so we
                can delete it promptly.
              </p>
            </PolicySection>

            <PolicySection title="International Data Transfers">
              <p>
                UMRAIO may use service providers located in different countries to host and process
                data. When information is transferred across borders, we rely on appropriate safeguards
                such as standard contractual clauses or equivalent mechanisms to protect it in accordance
                with applicable data protection laws.
              </p>
            </PolicySection>

            <PolicySection title="Changes to This Privacy Policy">
              <p>
                We may update this Privacy Policy from time to time to reflect changes in our practices,
                services or legal requirements. The updated version will be posted on this page with a
                revised “Last updated” date. We encourage you to review this page periodically.
              </p>
            </PolicySection>

            <PolicySection title="Contact Information">
              <p>
                If you have any questions, concerns or requests regarding this Privacy Policy or how we
                handle information, please contact us:
              </p>
              <p className="mt-2">
                <strong className="text-foreground">Email:</strong>{" "}
                <a
                  href="mailto:privacy@umraio.com"
                  className="text-primary underline underline-offset-4 transition-colors hover:text-primary-glow"
                >
                  privacy@umraio.com
                </a>
              </p>
              <p className="mt-1">
                <strong className="text-foreground">Website:</strong>{" "}
                <a
                  href="https://umraio.com"
                  className="text-primary underline underline-offset-4 transition-colors hover:text-primary-glow"
                >
                  https://umraio.com
                </a>
              </p>
            </PolicySection>
          </article>
        </main>

        <BrandArchitecture />
      </div>
    </div>
  );
}

function PolicySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel p-6 sm:p-8">
      <h2 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">{title}</h2>
      <div className="mt-4 space-y-3 text-sm font-light leading-relaxed text-muted-foreground sm:text-base">
        {children}
      </div>
    </section>
  );
}
