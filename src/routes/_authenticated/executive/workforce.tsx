import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/app/PageHeader";
import { WorkforceGrid } from "@/components/executive/WorkforceGrid";
import { EXECUTIVE_CENTER_DICT } from "@/lib/i18n/app/executive-center.i18n";
import { useCopy } from "@/lib/i18n/dict";

export const Route = createFileRoute("/_authenticated/executive/workforce")({
  head: () => ({
    meta: [
      { title: "AI Workforce Directory — UMRAIO AI Executive Center" },
      {
        name: "description",
        content:
          "Every UMRAIO specialist AI operator in one directory: real operating state, autonomy mode, active task and last actual execution.",
      },
      { property: "og:title", content: "AI Workforce Directory — UMRAIO AI Executive Center" },
      {
        property: "og:description",
        content: "Sales, WhatsApp, Marketing, Lead Intelligence and Content operators at a glance.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: WorkforceDirectory,
});

function WorkforceDirectory() {
  const copy = useCopy(EXECUTIVE_CENTER_DICT);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        backTo="/executive"
        backLabel={copy.breadcrumbCenter}
        eyebrow={copy.workforceEyebrow}
        title={copy.directoryTitle}
        description={copy.directorySubtitle}
      />
      <WorkforceGrid detailed />
    </div>
  );
}
