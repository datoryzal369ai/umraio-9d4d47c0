import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { AuthProvider } from "@/hooks/useAuth";
import { LocaleProvider } from "@/lib/i18n/locale";
import { useIdentitySignals } from "@/hooks/useIdentitySignals";
import { supabase } from "@/integrations/supabase/client";
import { Toaster } from "@/components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "UMRAIO® — AI Autonomous Business Executive for Umrah Agencies" },
      {
        name: "description",
        content:
          "UMRAIO® is an AI Autonomous Business Executive for Umrah agencies — helping automate WhatsApp enquiries, qualify leads, recommend packages, follow up and grow sales.",
      },

      { name: "author", content: "Digital Renaissance Metaverse" },
      {
        name: "google-site-verification",
        content: "N14_yClvXF3gWN0Iy9tBniKq3sLrkErDwmSFzy6alqc",
      },
      { property: "og:site_name", content: "UMRAIO®" },
      {
        property: "og:title",
        content: "UMRAIO® — AI Autonomous Business Executive for Umrah Agencies",
      },
      {
        property: "og:description",
        content:
          "UMRAIO® is an AI Autonomous Business Executive for Umrah agencies — helping automate WhatsApp enquiries, qualify leads, recommend packages, follow up and grow sales.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      {
        name: "twitter:title",
        content: "UMRAIO® — AI Autonomous Business Executive for Umrah Agencies",
      },
      {
        name: "twitter:description",
        content:
          "AI Autonomous Business Executive for Umrah agencies — WhatsApp enquiry automation, lead qualification, package recommendations and automated follow-up.",
      },

    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&family=Manrope:wght@400;500;600;700&display=swap",
      },
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      { rel: "icon", href: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { rel: "icon", href: "/favicon-48x48.png", type: "image/png", sizes: "48x48" },
      { rel: "icon", href: "/favicon-192x192.png", type: "image/png", sizes: "192x192" },
      { rel: "apple-touch-icon", href: "/favicon-180x180.png", sizes: "180x180" },
      { rel: "manifest", href: "/site.webmanifest" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "UMRAIO®",
          alternateName: "UMRAIO",
          url: "https://umraio.com/",
          logo: "https://umraio.com/favicon-512x512.png",
          image: "https://umraio.com/favicon-512x512.png",
          description:
            "UMRAIO® is an AI Autonomous Business Executive for Umrah agencies, automating WhatsApp enquiries, lead qualification, package recommendations and follow-up.",
          areaServed: "MY",
          brand: { "@type": "Brand", name: "UMRAVERSE®" },
          parentOrganization: { "@type": "Organization", name: "Digital Renaissance Metaverse" },
          knowsAbout: [
            "AI Autonomous Business Executive",
            "Umrah agency automation",
            "RENAIO.CORE™ Autonomous Intelligence Core",
            "UMRAVERSE® Umrah digital ecosystem",
          ],
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Brand",
          name: "RENAIO.CORE™",
          alternateName: ["RENAIO.CORE", "RÉNAIO.CORE™"],
          description:
            "RENAIO.CORE™ is the Autonomous Intelligence Core powering the Digital Renaissance ecosystem and its AI-native platforms, including UMRAVERSE® and UMRAIO®.",
          publisher: { "@type": "Organization", name: "Digital Renaissance Metaverse" },
        }),
      },

      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "UMRAIO®",
          applicationCategory: "BusinessApplication",
          applicationSubCategory: "AI Autonomous Business Executive",
          operatingSystem: "Web",
          url: "https://umraio.com/",
          description:
            "AI Autonomous Business Executive for Umrah agencies — WhatsApp enquiry automation, lead qualification, package recommendation, automated follow-up and business workflow automation.",
          featureList: [
            "WhatsApp enquiry automation",
            "Lead qualification",
            "Umrah package recommendation",
            "Automated follow-up",
            "Customer communication",
            "Sales and business workflow automation",
          ],
          audience: {
            "@type": "BusinessAudience",
            audienceType: "Umrah and Islamic travel agencies",
          },
          applicationSuite: "RENAIO.CORE™",
          publisher: { "@type": "Organization", name: "UMRAIO®" },

        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "UMRAIO®",
          alternateName: "UMRAIO® — AI Autonomous Business Executive for Umrah Agencies",
          url: "https://umraio.com/",
          inLanguage: "en",
          publisher: { "@type": "Organization", name: "UMRAIO®" },
        }),
      },

    ],
  }),

  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function AuthSync() {
  const router = useRouter();
  useIdentitySignals();

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
    });
    return () => data.subscription.unsubscribe();
  }, [router]);

  return null;
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <AuthProvider>
          <AuthSync />
          {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
          <Outlet />
          <Toaster position="top-right" richColors />
        </AuthProvider>
      </LocaleProvider>
    </QueryClientProvider>
  );
}
