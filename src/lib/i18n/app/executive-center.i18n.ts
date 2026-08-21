/**
 * UMRAIO® — AI Executive Center (flagship command center) copy.
 *
 * PRESENTATION ONLY. Covers the executive hero/telemetry strip, the semantic
 * worker state model, the AI Workforce directory and worker-local navigation.
 * Brand and product names are identical in both languages and locked:
 *   RÉNAIO.CORE™ · UMRAIO® · AI Executive Center ·
 *   AI AUTONOMOUS BUSINESS EXECUTIVE™ · AI SALES ELITE™
 */
import { createDict } from "@/lib/i18n/dict";
import type { WorkerRuntimeState, WorkerAutonomy } from "@/lib/executive/worker-state";

type CenterCopy = {
  heroEyebrow: string;
  heroTitle: string;
  heroSubtitle: string;
  heroLine: string;
  telemetry: {
    systemStatus: string;
    systemActive: string;
    systemSyncing: string;
    systemAttention: string;
    escalations: (n: number) => string;
    workers: string;
    workersOnline: (online: number, total: number) => string;
    awaitingActivation: (n: number) => string;
    noWorkers: string;
    tasks: string;
    tasksCoordinated: string;
    tasksToday: (n: number) => string;
    tasksTotal: (n: number) => string;
    tasksRecent: (n: number) => string;
    approvals: string;
    approvalsWaiting: (n: number) => string;
    approvalsClear: string;
    opportunities: string;
    opportunitiesDetected: (n: number) => string;
    opportunitiesNone: string;
  };
  nowTitle: string;
  nowHealthy: string;
  nowHealthyBody: string;
  nowWorkersOnline: (n: number) => string;
  nowNoEscalations: string;
  openApprovalQueue: string;
  openTaskControl: string;
  openOpportunities: string;
  viewWorkforce: string;
  workforceTitle: string;
  workforceSubtitle: string;
  workforceEyebrow: string;
  directoryTitle: string;
  directorySubtitle: string;
  whoLabel: string;
  roleLabel: string;
  stateLabel: string;
  autonomyLabel: string;
  activeTaskLabel: string;
  lastExecutionLabel: string;
  capabilitiesLabel: string;
  approvalLabel: string;
  openWorker: string;
  inspectActivity: string;
  neverExecuted: string;
  noActiveTask: string;
  readyForWork: string;
  readyForWorkBody: string;
  executionLabel: string;
  breadcrumbCenter: string;
  breadcrumbWorkforce: string;
  backToWorkforce: string;
  previousWorker: string;
  nextWorker: string;
  workforceNavigator: string;
  runtime: Record<WorkerRuntimeState, string>;
  autonomyValue: Record<WorkerAutonomy, string>;
  executiveSummary: string;
  recentActivity: string;
  actions: string;
  approvalRequiredNote: string;
  autonomousNote: string;
  pausedNote: string;
};

export const EXECUTIVE_CENTER_DICT = createDict<CenterCopy>({
  en: {
    heroEyebrow: "Human + AI Control Room",
    heroTitle: "AI Executive Center",
    heroSubtitle: "Your AI Workforce Command Center",
    heroLine: "Think. Decide. Coordinate. Execute. Monitor.",
    telemetry: {
      systemStatus: "System status",
      systemActive: "Active",
      systemSyncing: "Syncing",
      systemAttention: "Needs attention",
      escalations: (n) => `${n} escalated action${n === 1 ? "" : "s"}`,
      workers: "AI Workforce",
      workersOnline: (online, total) => `${online} / ${total} online`,
      awaitingActivation: (n) => `${n} awaiting activation`,
      noWorkers: "No workers provisioned",
      tasks: "Tasks",
      tasksCoordinated: "Coordinated",
      tasksToday: (n) => `+${n} today`,
      tasksTotal: (n) => `${n} total`,
      tasksRecent: (n) => `${n} in recent window`,
      approvals: "Approvals",
      approvalsWaiting: (n) => `${n} waiting`,
      approvalsClear: "Queue clear",
      opportunities: "Opportunities",
      opportunitiesDetected: (n) => `${n} detected`,
      opportunitiesNone: "None detected",
    },
    nowTitle: "Executive now",
    nowHealthy: "All systems operational",
    nowHealthyBody: "No decision requires you right now.",
    nowWorkersOnline: (n) => `${n} workers online`,
    nowNoEscalations: "No critical escalations",
    openApprovalQueue: "Open approval queue",
    openTaskControl: "Executive task control",
    openOpportunities: "Executive opportunities",
    viewWorkforce: "View AI Workforce",
    workforceTitle: "Specialist AI Workforce",
    workforceSubtitle: "Sales • WhatsApp • Marketing • Lead Intelligence • Content",
    workforceEyebrow: "AI Executive Center",
    directoryTitle: "AI Workforce directory",
    directorySubtitle:
      "Every specialist operator, its real state, current task and last actual execution.",
    whoLabel: "Worker",
    roleLabel: "Role",
    stateLabel: "Execution state",
    autonomyLabel: "Operating mode",
    activeTaskLabel: "Current task",
    lastExecutionLabel: "Last activity",
    capabilitiesLabel: "Capabilities",
    approvalLabel: "Approval",
    openWorker: "Open worker",
    inspectActivity: "Inspect activity",
    neverExecuted: "No activity yet",
    noActiveTask: "No task assigned",
    readyForWork: "Ready",
    readyForWorkBody: "No active task requires this worker right now.",
    executionLabel: "Execution",
    breadcrumbCenter: "AI Executive Center",
    breadcrumbWorkforce: "AI Workforce",
    backToWorkforce: "AI Workforce",
    previousWorker: "Previous worker",
    nextWorker: "Next worker",
    workforceNavigator: "AI Workforce navigator",
    runtime: {
      ready: "Ready",
      analysing: "Analysing",
      awaiting_approval: "Awaiting approval",
      executing: "Executing",
      monitoring: "Monitoring",
      completed: "Completed",
      failed: "Failed",
      escalated: "Escalated",
      never_run: "Never run",
      paused: "Paused",
    },
    autonomyValue: {
      autonomous: "Autonomous",
      approval_required: "Approval required",
      paused: "Paused",
    },
    executiveSummary: "Executive summary",
    recentActivity: "Recent activity",
    actions: "Actions",
    approvalRequiredNote: "Actions prepared by this worker need your approval before execution.",
    autonomousNote: "This worker may execute governed actions without asking first.",
    pausedNote: "This worker is paused and will not execute anything.",
  },
  bm: {
    heroEyebrow: "Bilik Kawalan Manusia + AI",
    heroTitle: "AI Executive Center",
    heroSubtitle: "Pusat Arahan Tenaga Kerja AI Anda",
    heroLine: "Fikir. Putus. Selaras. Laksana. Pantau.",
    telemetry: {
      systemStatus: "Status sistem",
      systemActive: "Aktif",
      systemSyncing: "Menyegerak",
      systemAttention: "Perlu perhatian",
      escalations: (n) => `${n} tindakan dieskalasi`,
      workers: "Tenaga Kerja AI",
      workersOnline: (online, total) => `${online} / ${total} dalam talian`,
      awaitingActivation: (n) => `${n} menunggu pengaktifan`,
      noWorkers: "Tiada pekerja disediakan",
      tasks: "Tugasan",
      tasksCoordinated: "Diselaraskan",
      tasksToday: (n) => `+${n} hari ini`,
      tasksTotal: (n) => `${n} jumlah`,
      tasksRecent: (n) => `${n} dalam tetingkap terkini`,
      approvals: "Kelulusan",
      approvalsWaiting: (n) => `${n} menunggu`,
      approvalsClear: "Barisan kosong",
      opportunities: "Peluang",
      opportunitiesDetected: (n) => `${n} dikesan`,
      opportunitiesNone: "Tiada dikesan",
    },
    nowTitle: "Eksekutif sekarang",
    nowHealthy: "Semua sistem beroperasi",
    nowHealthyBody: "Tiada keputusan memerlukan anda buat masa ini.",
    nowWorkersOnline: (n) => `${n} pekerja dalam talian`,
    nowNoEscalations: "Tiada eskalasi kritikal",
    openApprovalQueue: "Buka barisan kelulusan",
    openTaskControl: "Kawalan tugasan eksekutif",
    openOpportunities: "Peluang eksekutif",
    viewWorkforce: "Lihat Tenaga Kerja AI",
    workforceTitle: "Tenaga Kerja AI Pakar",
    workforceSubtitle: "Sales • WhatsApp • Marketing • Lead Intelligence • Content",
    workforceEyebrow: "AI Executive Center",
    directoryTitle: "Direktori Tenaga Kerja AI",
    directorySubtitle:
      "Setiap operator pakar, keadaan sebenar, tugasan semasa dan pelaksanaan terakhir.",
    whoLabel: "Pekerja",
    roleLabel: "Peranan",
    stateLabel: "Execution state",
    autonomyLabel: "Operating mode",
    activeTaskLabel: "Current task",
    lastExecutionLabel: "Last activity",
    capabilitiesLabel: "Keupayaan",
    approvalLabel: "Kelulusan",
    openWorker: "Open worker",
    inspectActivity: "Periksa aktiviti",
    neverExecuted: "No activity yet",
    noActiveTask: "No task assigned",
    readyForWork: "Ready",
    readyForWorkBody: "Tiada tugasan aktif memerlukan pekerja ini sekarang.",
    executionLabel: "Execution",
    breadcrumbCenter: "AI Executive Center",
    breadcrumbWorkforce: "AI Workforce",
    backToWorkforce: "AI Workforce",
    previousWorker: "Pekerja sebelum",
    nextWorker: "Pekerja seterusnya",
    workforceNavigator: "AI Workforce navigator",
    runtime: {
      ready: "Ready",
      analysing: "Analysing",
      awaiting_approval: "Awaiting approval",
      executing: "Executing",
      monitoring: "Monitoring",
      completed: "Completed",
      failed: "Failed",
      escalated: "Escalated",
      never_run: "Never run",
      paused: "Paused",
    },
    autonomyValue: {
      autonomous: "Autonomous",
      approval_required: "Approval required",
      paused: "Paused",
    },
    executiveSummary: "Ringkasan eksekutif",
    recentActivity: "Aktiviti terkini",
    actions: "Tindakan",
    approvalRequiredNote: "Tindakan pekerja ini perlu kelulusan anda sebelum dilaksanakan.",
    autonomousNote: "Pekerja ini boleh melaksanakan tindakan terkawal tanpa bertanya dahulu.",
    pausedNote: "Pekerja ini dijeda dan tidak akan melaksanakan apa-apa.",
  },
});
