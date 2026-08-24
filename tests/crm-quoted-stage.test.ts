import { describe, expect, test } from "bun:test";

import { LEAD_STAGES, STAGE_LABELS, type LeadStage } from "../src/lib/leads";
import { leadsCopy } from "../src/lib/i18n/app/leads.i18n";
import { WORKSPACE_COPY } from "../src/lib/i18n/app/workspace.i18n";

// Mirrors the DB enum public.lead_stage.
const DB_LEAD_STAGES = [
  "new",
  "contacted",
  "qualified",
  "proposal",
  "negotiation",
  "booked",
  "completed",
  "lost",
] as const;

describe("CRM quoted stage (P0-2)", () => {
  test("proposal is part of the canonical lead-stage definition", () => {
    expect(LEAD_STAGES).toContain("proposal" as LeadStage);
  });

  test("a lead with stage=proposal lands in a visible CRM pipeline column", () => {
    const leads = [{ id: "l1", stage: "proposal" as LeadStage }];
    const columns = LEAD_STAGES.map((stage) => ({
      stage,
      items: leads.filter((l) => l.stage === stage),
    }));
    const quoted = columns.find((c) => c.stage === "proposal");
    expect(quoted).toBeDefined();
    expect(quoted!.items).toHaveLength(1);
  });

  test('proposal is displayed as "Quoted"', () => {
    expect(STAGE_LABELS.proposal).toBe("Quoted");
    expect(WORKSPACE_COPY.en.stageLabels.proposal).toBe("Quoted");
  });

  test("every database stage value is renderable — no lead can disappear", () => {
    for (const stage of DB_LEAD_STAGES) {
      expect(LEAD_STAGES).toContain(stage as LeadStage);
      expect(STAGE_LABELS[stage as LeadStage]).toBeTruthy();
      expect(leadsCopy.en.stageLabels[stage]).toBeTruthy();
      expect(leadsCopy.ms.stageLabels[stage]).toBeTruthy();
      expect(WORKSPACE_COPY.ms.stageLabels[stage]).toBeTruthy();
    }
  });

  test("existing stages remain visible and ordered before terminal stages", () => {
    for (const stage of ["new", "contacted", "qualified", "negotiation", "booked", "completed", "lost"]) {
      expect(LEAD_STAGES).toContain(stage as LeadStage);
    }
    expect(LEAD_STAGES.indexOf("proposal")).toBeGreaterThan(LEAD_STAGES.indexOf("qualified"));
    expect(LEAD_STAGES.indexOf("proposal")).toBeLessThan(LEAD_STAGES.indexOf("booked"));
  });
});
