import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";

import { PageHeader } from "@/components/app/PageHeader";
import { settingsCopy } from "@/lib/i18n/app/settings.i18n";
import { useCopy } from "@/lib/i18n/dict";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const copy = useCopy(settingsCopy).layout;

  const tabs = [
    { to: "/settings/agency", label: copy.tabs.agency },
    { to: "/settings/ai", label: copy.tabs.ai },
    { to: "/settings/whatsapp", label: copy.tabs.whatsapp },
    { to: "/settings/governance", label: copy.tabs.governance },
    { to: "/settings/notifications", label: copy.tabs.notifications },

    { to: "/settings/api-keys", label: copy.tabs.apiKeys },
    { to: "/settings/subscription", label: copy.tabs.subscription },
  ] as const;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        description={copy.description}
      />

      <nav
        aria-label={copy.navLabel}
        className="-mx-1 flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1"
      >
        {tabs.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={pathname === tab.to ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              pathname === tab.to
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
