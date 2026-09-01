import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  BookOpen,
  BrainCircuit,
  FileText,
  HeartHandshake,
  KanbanSquare,
  ListChecks,
  LayoutDashboard,
  LineChart,
  LogOut,
  Megaphone,
  Menu,
  MessageCircle,
  MessagesSquare,
  PenLine,
  Radar,
  Repeat,
  Settings,
  Target,
  UserRound,
  Users,
  X,
} from "lucide-react";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { BrandLogo } from "@/components/brand/BrandLogo";
import { Button } from "@/components/ui/button";
import { LanguageSelector } from "@/components/app/LanguageSelector";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCopy } from "@/lib/i18n/dict";
import { shellCopy } from "@/lib/i18n/app/shell.i18n";
import { cn } from "@/lib/utils";

/** Highlights the nav entry that owns the current pathname, including nested routes. */
function isActive(pathname: string, to: string) {
  if (to === "/settings/whatsapp") return pathname === to;
  if (to === "/settings/agency")
    return pathname.startsWith("/settings") && pathname !== "/settings/whatsapp";
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const t = useCopy(shellCopy).shell;

  const { role, isPlatformOwner: founder } = useMyRoles();

  const allNavItems = [
    ...(founder ? [{ to: "/hq", label: "Founder HQ", icon: ShieldCheck } as const] : []),
    { to: "/dashboard", label: t.nav.dashboard, icon: LayoutDashboard },
    { to: "/executive", label: t.nav.executive, icon: BrainCircuit },
    { to: "/tasks", label: t.nav.tasks, icon: ListChecks },
    { to: "/crm", label: t.nav.crm, icon: KanbanSquare },
    { to: "/leads", label: t.nav.leads, icon: Users },
    { to: "/conversations", label: t.nav.conversations, icon: MessagesSquare },
    { to: "/analytics", label: t.nav.analytics, icon: BarChart3 },
    { to: "/knowledge", label: t.nav.knowledge, icon: BookOpen },
    { to: "/settings/whatsapp", label: t.nav.whatsapp, icon: MessageCircle },
    { to: "/settings/agency", label: t.nav.settings, icon: Settings },
    { to: "/profile", label: t.nav.profile, icon: UserRound },
  ] as const;

  // Presentation-level filtering only; the server remains authoritative.
  const navItems = allNavItems.filter(
    (item) => item.to === "/hq" || canSeeNavItem(role, item.to),
  );


  /** Live AI workers, managed from the AI Executive Center. */
  const activeWorkers = [
    { key: "whatsapp", label: t.workers.whatsapp, icon: MessageCircle },
    { key: "marketing", label: t.workers.marketing, icon: Megaphone },
    { key: "content", label: t.workers.content, icon: PenLine },
    { key: "lead_intel", label: t.workers.lead_intel, icon: Radar },
  ] as const;

  /** Reserved slots for the future UMRAIO® AI workforce. Navigation only — not yet implemented. */
  const futureModules = [
    { label: t.futureModules.quotation, icon: FileText },
    { label: t.futureModules.followup, icon: Repeat },
    { label: t.futureModules.customerSuccess, icon: HeartHandshake },
    { label: t.futureModules.insights, icon: LineChart },
  ] as const;

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    toast.success(t.signedOutToast);
    navigate({ to: "/auth", search: { mode: "login" }, replace: true });
  }

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {navItems.map((item) => {
        const active = isActive(pathname, item.to);
        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={active ? "page" : undefined}
            onClick={() => setOpen(false)}
            className={cn(
              "flex min-h-10 items-center gap-3 rounded-lg px-3 py-1.5 text-[13px] font-medium leading-5 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <item.icon aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}

      <p className="mb-1 mt-5 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
        {t.aiWorkforce}
      </p>
      <ul className="flex flex-col gap-0.5">
        <li>
          <Link
            to="/sales-elite"
            onClick={() => setOpen(false)}
            aria-current={isActive(pathname, "/sales-elite") ? "page" : undefined}
            className={cn(
              "flex min-h-10 items-center gap-3 rounded-lg px-3 py-1.5 text-[13px] font-medium leading-5 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
              isActive(pathname, "/sales-elite")
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <Target aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{t.workers.sales_elite}</span>
            <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
          </Link>
        </li>
        {activeWorkers.map((worker) => (
          <li key={worker.key}>
            <Link
              to="/executive/$workerKey"
              params={{ workerKey: worker.key }}
              onClick={() => setOpen(false)}
              className={cn(
                "flex min-h-10 items-center gap-3 rounded-lg px-3 py-1.5 text-[13px] font-medium leading-5 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
                pathname === `/executive/${worker.key}`
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <worker.icon aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">{worker.label}</span>
              <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
            </Link>
          </li>
        ))}
      </ul>

      <ul className="mt-3 flex flex-col gap-0.5">
        {futureModules.map((module) => (
          <li
            key={module.label}
            className="flex min-h-10 cursor-not-allowed items-center gap-3 rounded-lg px-3 py-1.5 text-[13px] font-medium leading-5 text-muted-foreground/60"
            aria-disabled="true"
          >
            <module.icon aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{module.label}</span>
            <span className="ml-auto shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[9px] uppercase tracking-wider">
              {t.upcoming}
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );


  return (
    <div className="flex min-h-dvh bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        {t.skipToContent}
      </a>

      <aside className="hidden w-64 shrink-0 flex-col justify-between gap-4 border-r border-sidebar-border bg-sidebar px-4 py-5 lg:flex">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <BrandLogo showTagline className="mb-5 px-1" />
          {nav}
        </div>
        <div className="space-y-3">
          <LanguageSelector className="w-full justify-center" />
          <SignOutBlock email={user?.email ?? ""} onSignOut={handleSignOut} signOutLabel={t.signOut} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-5 py-3 lg:hidden">
          <BrandLogo />
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11"
                aria-label={t.openNav}
              >
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              showCloseButton={false}
              className="flex w-[min(22rem,100vw)] flex-col justify-between gap-4 bg-sidebar px-5 pb-5 pt-[max(16px,env(safe-area-inset-top))]"
            >
              <SheetTitle className="sr-only">{t.navigation}</SheetTitle>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mb-5 flex items-start justify-between gap-6">
                  <BrandLogo showTagline className="min-w-0" />
                  <SheetClose asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="relative z-10 size-11 shrink-0 rounded-xl"
                      aria-label={t.closeNav}
                    >
                      <X aria-hidden="true" className="size-5" />
                    </Button>
                  </SheetClose>
                </div>
                {nav}
              </div>
              <div className="space-y-3">
                <LanguageSelector className="w-full justify-center" />
                <SignOutBlock email={user?.email ?? ""} onSignOut={handleSignOut} signOutLabel={t.signOut} />
              </div>
            </SheetContent>
          </Sheet>
        </header>

        <main id="main-content" className="min-w-0 flex-1 p-5 sm:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function SignOutBlock({
  email,
  onSignOut,
  signOutLabel,
}: {
  email: string;
  onSignOut: () => void;
  signOutLabel: string;
}) {
  return (
    <div className="space-y-3 border-t border-sidebar-border pt-4">
      <p className="truncate text-xs text-muted-foreground">{email}</p>
      <Button variant="outline" size="sm" className="w-full" onClick={onSignOut}>
        <LogOut aria-hidden="true" className="size-4" />
        {signOutLabel}
      </Button>
    </div>
  );
}
