/**
 * UMRAIO® — AI Executive Center copy localization.
 *
 * PRESENTATION ONLY. BM/EN copy for:
 *  - /executive (Executive Center overview)
 *  - /executive/$workerKey (single worker detail)
 *  - ExecutiveCommandPanel
 *  - OrchestrationPanel
 *  - SalesOpportunities
 *
 * Consumes the single locale context in src/lib/i18n/locale.tsx via
 * createDict/useCopy from src/lib/i18n/dict.ts. Brand/technical terms are
 * kept identical in both languages: UMRAIO®, RAIŌ, RÉNAIO.CORE™,
 * UMRAVERSE®, AI Autonomous Business Executive, AI WhatsApp Executive,
 * AI Marketing Executive, AI Content Executive, AI Lead Intelligence,
 * Islamic Implementation Layer™, WhatsApp, AI, API, CRM, Dashboard,
 * Knowledge Base, HITL, Umrah.
 */
import { createDict } from "@/lib/i18n/dict";

type ExecutiveCopy = {
  overview: {
    eyebrow: string;
    title: string;
    description: string;
    waitingApproval: (n: number) => string;
    syncing: string;
    tasksCompletedLabel: string;
    tasksCompletedHint: string;
    messagesAnsweredLabel: string;
    messagesAnsweredHint: string;
    leadsGeneratedLabel: string;
    leadsGeneratedHint: string;
    bookingsAssistedLabel: string;
    bookingsAssistedHint: string;
    revenueInfluencedLabel: string;
    revenueInfluencedHint: string;
    hoursSavedLabel: string;
    hoursSavedHint: string;
    lastRun: (rel: string) => string;
    notRunYet: string;
    autonomous: string;
    approvalRequired: string;
    openWorker: string;
    latestTasksTitle: string;
    latestTasksSubtitle: string;
    noTasksYet: string;
    processing: string;
    activityLogTitle: string;
    activityLogSubtitle: string;
    nothingLoggedYet: string;
    minAgo: (n: number) => string;
    hAgo: (n: number) => string;
    dAgo: (n: number) => string;
  };
  workerDetail: {
    backToExecutiveCenter: string;
    eyebrow: string;
    fallbackTitle: string;
    fallbackDescription: string;
    pauseWorker: string;
    activateWorker: string;
    assignTaskTitle: string;
    assignTaskDescription: string;
    briefPlaceholder: string;
    briefAriaLabel: string;
    workerPausedNotice: string;
    taskHistoryTitle: string;
    loadingTasksSkeletonLabel: string;
    noTasksForWorker: string;
    processing: string;
    savesMinutes: (min: number) => string;
    approve: string;
    reject: string;
    hideOutput: string;
    viewOutput: (sections: number) => string;
    toastTaskFinished: string;
    toastApproved: string;
    toastRejected: string;
  };
  commandPanel: {
    whereThisSits: string;
    hierarchy: {
      core: string;
      umraio: string;
      executiveCenter: string;
      orchestrator: string;
      workforce: string;
    };
    title: string;
    subtitle: string;
    syncing: string;
    active: string;
    idle: string;
    roles: {
      understand: string;
      prioritise: string;
      coordinate: string;
      recommend: string;
      monitor: string;
      escalate: string;
    };
    workerRoles: {
      whatsapp: string[];
      marketing: string[];
      content: string[];
      leadIntel: string[];
    };
    metricActiveWorkers: string;
    metricTasksCoordinated: string;
    metricLeadsPrioritised: string;
    metricAwaitingApproval: string;
    metricOpportunitiesDetected: string;
    briefTitle: string;
    briefError: string;
    workforceWorking: (running: number, queued: number, completed: number) => string;
    workforceIdle: string;
    highIntentWithStale: (highIntent: number, stale: number) => string;
    highIntentAllContacted: (highIntent: number) => string;
    noOpportunities: string;
    pendingApprovalsExist: (n: number) => string;
    noPendingApprovals: string;
    tasksFailed: (n: number) => string;
    recommendedNextAction: string;
    recommendedReviewApprovals: string;
    recommendedFollowUp: (name: string, score: number) => string;
    recommendedNothingUrgent: string;
    viewPendingApprovals: string;
    viewHighIntentLeads: string;
    viewExecutiveAnalytics: string;
    advisoryNotice: string;
    orchestrationHeading: string;
    specialistWorker: string;
    paused: string;
    autonomous: string;
    approvalRequired: string;
  };
  orchestration: {
    justNow: string;
    minAgo: (n: number) => string;
    hAgo: (n: number) => string;
    dAgo: (n: number) => string;
    title: string;
    subtitle: string;
    runningCycle: string;
    runCycleNow: string;
    autonomyLabel: string;
    autonomyOff: string;
    autonomyAssisted: string;
    autonomyAutonomous: string;
    lastCycle: string;
    scheduled: string;
    manual: string;
    neverRun: string;
    nextEligibleCycle: string;
    autonomyNotEnabled: string;
    atNextScheduledTick: string;
    nowAtNextScheduledTick: string;
    lastOutcome: string;
    dash: string;
    executedAwaiting: (executed: number, awaiting: number) => string;
    noCycleYet: string;
    cycleSummary: (rel: string, considered: number, attempted: number, executed: number, limitReached: boolean) => string;
    decisionLabel: string;
    whyLabel: string;
    actionLabel: string;
    resultLabel: string;
    noPermittedAction: string;
    toastAutonomySet: (mode: string) => string;
    toastAutonomyError: string;
    toastCycleFinished: (executed: number, attempted: number) => string;
    toastCycleFailed: string;
    toastCycleFailedFallback: string;
    footerNotice: string;
    statusOrchestrating: string;
    statusFailed: string;
    statusEscalated: string;
    statusCompleted: string;
    statusAdvisory: string;
    statusNoActionTaken: string;
    statusIdle: string;
    skipped: string;
    autonomyModeAriaLabel: string;
  };
  opportunities: {
    title: string;
    subtitle: string;
    detected: (n: number) => string;
    loadError: string;
    noneDetected: string;
    openLead: string;
    openConversation: string;
    lastContact: (rel: string) => string;
    neverContacted: string;
    viewAllInCrm: string;
  };
};

export const EXECUTIVE_DICT = createDict<ExecutiveCopy>({
  en: {
    overview: {
      eyebrow: "AI Executive Center",
      title: "Your AI workforce",
      description: "Think, plan, decide, execute, report — every AI worker in one control room.",
      waitingApproval: (n) => `${n} waiting for approval`,
      syncing: "Syncing…",
      tasksCompletedLabel: "Tasks completed today",
      tasksCompletedHint: "AI worker jobs executed",
      messagesAnsweredLabel: "Messages answered",
      messagesAnsweredHint: "AI replies sent today",
      leadsGeneratedLabel: "Leads generated",
      leadsGeneratedHint: "New leads captured today",
      bookingsAssistedLabel: "Bookings assisted",
      bookingsAssistedHint: "Bookings created today",
      revenueInfluencedLabel: "Revenue influenced",
      revenueInfluencedHint: "Value of today's bookings",
      hoursSavedLabel: "Hours saved",
      hoursSavedHint: "Human hours replaced today",
      lastRun: (rel) => `Last run ${rel}`,
      notRunYet: "Not run yet",
      autonomous: "Autonomous",
      approvalRequired: "Approval required",
      openWorker: "Open worker",
      latestTasksTitle: "Latest AI tasks",
      latestTasksSubtitle: "What the workforce produced recently",
      noTasksYet: "No AI tasks yet. Open a worker to run one.",
      processing: "Processing…",
      activityLogTitle: "Activity log",
      activityLogSubtitle: "Every AI and human action",
      nothingLoggedYet: "Nothing logged yet.",
      minAgo: (n) => `${n}m ago`,
      hAgo: (n) => `${n}h ago`,
      dAgo: (n) => `${n}d ago`,
    },
    workerDetail: {
      backToExecutiveCenter: "AI Executive Center",
      eyebrow: "AI Worker",
      fallbackTitle: "AI worker",
      fallbackDescription: "Loading worker…",
      pauseWorker: "Pause worker",
      activateWorker: "Activate worker",
      assignTaskTitle: "Assign a task",
      assignTaskDescription: "Add an optional brief, then let the worker plan and execute.",
      briefPlaceholder: "Optional brief — e.g. focus on Ramadan 2027 departures for families from Johor.",
      briefAriaLabel: "Task brief",
      workerPausedNotice: "This worker is paused. Activate it to assign new tasks.",
      taskHistoryTitle: "Task history",
      loadingTasksSkeletonLabel: "Loading task history",
      noTasksForWorker: "No tasks yet for this worker.",
      processing: "Processing…",
      savesMinutes: (min) => `saves ~${min} min`,
      approve: "Approve",
      reject: "Reject",
      hideOutput: "Hide output",
      viewOutput: (sections) => `View output (${sections} sections)`,
      toastTaskFinished: "AI worker finished the task.",
      toastApproved: "Output approved.",
      toastRejected: "Output rejected.",
    },
    commandPanel: {
      whereThisSits: "Where this sits",
      hierarchy: {
        core: "Autonomous Intelligence Core",
        umraio: "Autonomous AI Workforce for Umrah Agencies",
        executiveCenter: "Human + AI Control Room",
        orchestrator: "AI Business Director & Orchestrator",
        workforce: "Sales Elite • WhatsApp • Marketing • Content • Lead Intelligence",
      },
      title: "AI Autonomous Business Executive™",
      subtitle: "AI Business Director & Workforce Orchestrator",
      syncing: "Syncing…",
      active: "Active",
      idle: "Idle",
      roles: {
        understand: "Understand",
        prioritise: "Prioritise",
        coordinate: "Coordinate",
        recommend: "Recommend",
        monitor: "Monitor",
        escalate: "Escalate",
      },
      workerRoles: {
        whatsapp: ["Respond", "Engage", "Qualify", "Escalate"],
        marketing: ["Plan", "Optimise", "Generate demand"],
        content: ["Create", "Adapt", "Prepare content"],
        leadIntel: ["Analyse", "Score", "Predict", "Recommend"],
      },
      metricActiveWorkers: "Active workers",
      metricTasksCoordinated: "Tasks coordinated",
      metricLeadsPrioritised: "Leads prioritised",
      metricAwaitingApproval: "Awaiting approval",
      metricOpportunitiesDetected: "Opportunities detected",
      briefTitle: "Today's executive brief",
      briefError: "Could not load executive data. Refresh to try again.",
      workforceWorking: (running, queued, completed) =>
        `Workforce is working: ${running} running, ${queued} queued, ${completed} completed.`,
      workforceIdle: "No workforce activity yet — assign a task to a worker below.",
      highIntentWithStale: (highIntent, stale) =>
        `${highIntent} high-intent leads open, ${stale} with no contact in the last 24h.`,
      highIntentAllContacted: (highIntent) =>
        `${highIntent} high-intent leads open — all contacted in the last 24h.`,
      noOpportunities: "No high-priority opportunities detected.",
      pendingApprovalsExist: (n) => `${n} AI actions are prepared and waiting for your approval.`,
      noPendingApprovals: "No pending approvals.",
      tasksFailed: (n) => `${n} tasks failed and need review.`,
      recommendedNextAction: "Recommended next action: ",
      recommendedReviewApprovals: "Review and clear the pending approvals in the AI Task Center.",
      recommendedFollowUp: (name, score) => `Prioritise follow-up for ${name} (score ${score}).`,
      recommendedNothingUrgent: "Nothing urgent. Keep the workforce running.",
      viewPendingApprovals: "View pending approvals",
      viewHighIntentLeads: "View high-intent leads",
      viewExecutiveAnalytics: "View executive analytics",
      advisoryNotice:
        "Orchestration is advisory today: the executive prioritises, recommends and monitors from real workforce data. Every action is executed by a specialist worker under existing permissions, tool validation, approval workflow and audit logging.",
      orchestrationHeading: "Orchestration",
      specialistWorker: "Specialist worker",
      paused: "Paused",
      autonomous: "Autonomous",
      approvalRequired: "Approval required",
    },
    orchestration: {
      justNow: "just now",
      minAgo: (n) => `${n}m ago`,
      hAgo: (n) => `${n}h ago`,
      dAgo: (n) => `${n}d ago`,
      title: "Governed autonomous execution",
      subtitle: "Understand → prioritise → decide → execute through existing governed tools → observe.",
      runningCycle: "Running cycle…",
      runCycleNow: "Run cycle now",
      autonomyLabel: "AI autonomy",
      autonomyOff: "Off — no scheduled cycles",
      autonomyAssisted: "Assisted — recommend only",
      autonomyAutonomous: "Autonomous — governed execution",
      lastCycle: "Last cycle",
      scheduled: "Scheduled",
      manual: "Manual",
      neverRun: "Never run",
      nextEligibleCycle: "Next eligible cycle",
      autonomyNotEnabled: "Autonomy not enabled",
      atNextScheduledTick: "At the next scheduled tick",
      nowAtNextScheduledTick: "Now — at the next scheduled tick",
      lastOutcome: "Last outcome",
      dash: "—",
      executedAwaiting: (executed, awaiting) => `${executed} executed · ${awaiting} awaiting approval`,
      noCycleYet:
        "No orchestration cycle has run yet. Run one to let the executive prioritise real leads and act through the governed tool layer.",
      cycleSummary: (rel, considered, attempted, executed, limitReached) =>
        `Last cycle ${rel} · ${considered} priorities considered · ${attempted} actions attempted · ${executed} executed${limitReached ? " · cycle limit reached" : ""}`,
      decisionLabel: "Decision",
      whyLabel: "Why",
      actionLabel: "Action",
      resultLabel: "Result",
      noPermittedAction: "No permitted action",
      toastAutonomySet: (mode) => `AI autonomy set to ${mode}.`,
      toastAutonomyError: "Could not change autonomy mode.",
      toastCycleFinished: (executed, attempted) =>
        `Orchestration cycle finished — ${executed} action(s) executed of ${attempted} attempted.`,
      toastCycleFailed: "Orchestration cycle failed.",
      toastCycleFailedFallback: "Orchestration cycle failed.",
      footerNotice:
        "Every action runs through the existing tool registry: allowlist → schema → permission → business rule → execution → audit. Customer-facing messages are never sent autonomously, and a cycle stops after a fixed number of actions.",
      statusOrchestrating: "Orchestrating",
      statusFailed: "Failed",
      statusEscalated: "Escalated",
      statusCompleted: "Completed",
      statusAdvisory: "Advisory",
      statusNoActionTaken: "No action taken",
      statusIdle: "Idle",
      skipped: "Skipped",
      autonomyModeAriaLabel: "AI autonomy mode",
    },
    opportunities: {
      title: "Sales opportunities",
      subtitle: "Detected from your live leads, conversations and follow-ups",
      detected: (n) => `${n} detected`,
      loadError: "Could not load sales opportunities. Refresh to try again.",
      noneDetected: "No active sales opportunities detected.",
      openLead: "Open lead",
      openConversation: "Open conversation",
      lastContact: (rel) => `Last contact ${rel}`,
      neverContacted: "Never contacted",
      viewAllInCrm: "View all in CRM pipeline",
    },
  },
  bm: {
    overview: {
      eyebrow: "AI Executive Center",
      title: "Tenaga kerja AI anda",
      description: "Fikir, rancang, putuskan, laksana, laporkan — setiap AI worker dalam satu bilik kawalan.",
      waitingApproval: (n) => `${n} menunggu kelulusan`,
      syncing: "Menyegerak…",
      tasksCompletedLabel: "Tugasan selesai hari ini",
      tasksCompletedHint: "Kerja AI worker yang dilaksanakan",
      messagesAnsweredLabel: "Mesej dijawab",
      messagesAnsweredHint: "Balasan AI dihantar hari ini",
      leadsGeneratedLabel: "Lead dijana",
      leadsGeneratedHint: "Lead baharu diperoleh hari ini",
      bookingsAssistedLabel: "Tempahan dibantu",
      bookingsAssistedHint: "Tempahan dicipta hari ini",
      revenueInfluencedLabel: "Hasil dipengaruhi",
      revenueInfluencedHint: "Nilai tempahan hari ini",
      hoursSavedLabel: "Jam dijimatkan",
      hoursSavedHint: "Jam manusia digantikan hari ini",
      lastRun: (rel) => `Dijalankan kali terakhir ${rel}`,
      notRunYet: "Belum dijalankan",
      autonomous: "Autonomi",
      approvalRequired: "Perlu kelulusan",
      openWorker: "Buka worker",
      latestTasksTitle: "Tugasan AI terkini",
      latestTasksSubtitle: "Apa yang dihasilkan tenaga kerja baru-baru ini",
      noTasksYet: "Tiada tugasan AI lagi. Buka satu worker untuk menjalankannya.",
      processing: "Sedang diproses…",
      activityLogTitle: "Log aktiviti",
      activityLogSubtitle: "Setiap tindakan AI dan manusia",
      nothingLoggedYet: "Belum ada rekod lagi.",
      minAgo: (n) => `${n}m lalu`,
      hAgo: (n) => `${n}j lalu`,
      dAgo: (n) => `${n}h lalu`,
    },
    workerDetail: {
      backToExecutiveCenter: "AI Executive Center",
      eyebrow: "AI Worker",
      fallbackTitle: "AI worker",
      fallbackDescription: "Memuatkan worker…",
      pauseWorker: "Jeda worker",
      activateWorker: "Aktifkan worker",
      assignTaskTitle: "Berikan tugasan",
      assignTaskDescription: "Tambah brief pilihan, kemudian biarkan worker merancang dan melaksanakannya.",
      briefPlaceholder: "Brief pilihan — cth. fokus pada tempahan Ramadan 2027 untuk keluarga dari Johor.",
      briefAriaLabel: "Brief tugasan",
      workerPausedNotice: "Worker ini sedang dijeda. Aktifkannya untuk memberikan tugasan baharu.",
      taskHistoryTitle: "Sejarah tugasan",
      loadingTasksSkeletonLabel: "Memuatkan sejarah tugasan",
      noTasksForWorker: "Belum ada tugasan untuk worker ini.",
      processing: "Sedang diproses…",
      savesMinutes: (min) => `menjimatkan ~${min} minit`,
      approve: "Luluskan",
      reject: "Tolak",
      hideOutput: "Sembunyikan output",
      viewOutput: (sections) => `Lihat output (${sections} bahagian)`,
      toastTaskFinished: "AI worker telah selesaikan tugasan.",
      toastApproved: "Output diluluskan.",
      toastRejected: "Output ditolak.",
    },
    commandPanel: {
      whereThisSits: "Di mana kedudukannya",
      hierarchy: {
        core: "Teras Kecerdasan Autonomi",
        umraio: "Tenaga Kerja AI Autonomi untuk Agensi Umrah",
        executiveCenter: "Bilik Kawalan Manusia + AI",
        orchestrator: "Pengarah Perniagaan AI & Orkestrator",
        workforce: "Sales Elite • WhatsApp • Pemasaran • Kandungan • Kecerdasan Lead",
      },
      title: "AI Autonomous Business Executive™",
      subtitle: "Pengarah Perniagaan AI & Orkestrator Tenaga Kerja",
      syncing: "Menyegerak…",
      active: "Aktif",
      idle: "Idle",
      roles: {
        understand: "Fahami",
        prioritise: "Utamakan",
        coordinate: "Selaraskan",
        recommend: "Cadangkan",
        monitor: "Pantau",
        escalate: "Eskalasi",
      },
      workerRoles: {
        whatsapp: ["Balas", "Libatkan", "Sahkan", "Eskalasi"],
        marketing: ["Rancang", "Optimumkan", "Jana permintaan"],
        content: ["Cipta", "Sesuaikan", "Sediakan kandungan"],
        leadIntel: ["Analisis", "Skor", "Ramal", "Cadangkan"],
      },
      metricActiveWorkers: "Worker aktif",
      metricTasksCoordinated: "Tugasan diselaraskan",
      metricLeadsPrioritised: "Lead diutamakan",
      metricAwaitingApproval: "Menunggu kelulusan",
      metricOpportunitiesDetected: "Peluang dikesan",
      briefTitle: "Ringkasan eksekutif hari ini",
      briefError: "Tidak dapat memuatkan data eksekutif. Muat semula untuk cuba lagi.",
      workforceWorking: (running, queued, completed) =>
        `Tenaga kerja sedang bekerja: ${running} berjalan, ${queued} dalam giliran, ${completed} selesai.`,
      workforceIdle: "Belum ada aktiviti tenaga kerja — berikan tugasan kepada worker di bawah.",
      highIntentWithStale: (highIntent, stale) =>
        `${highIntent} lead berminat tinggi masih terbuka, ${stale} tiada hubungan dalam 24 jam lepas.`,
      highIntentAllContacted: (highIntent) =>
        `${highIntent} lead berminat tinggi masih terbuka — semua telah dihubungi dalam 24 jam lepas.`,
      noOpportunities: "Tiada peluang keutamaan tinggi dikesan.",
      pendingApprovalsExist: (n) => `${n} tindakan AI telah disediakan dan menunggu kelulusan anda.`,
      noPendingApprovals: "Tiada kelulusan tertangguh.",
      tasksFailed: (n) => `${n} tugasan gagal dan perlu disemak.`,
      recommendedNextAction: "Tindakan seterusnya yang disyorkan: ",
      recommendedReviewApprovals: "Semak dan selesaikan kelulusan tertangguh di AI Task Center.",
      recommendedFollowUp: (name, score) => `Utamakan susulan untuk ${name} (skor ${score}).`,
      recommendedNothingUrgent: "Tiada yang mendesak. Teruskan tenaga kerja berjalan.",
      viewPendingApprovals: "Lihat kelulusan tertangguh",
      viewHighIntentLeads: "Lihat lead berminat tinggi",
      viewExecutiveAnalytics: "Lihat analitik eksekutif",
      advisoryNotice:
        "Orkestrasi bersifat penasihat pada masa ini: eksekutif mengutamakan, mencadangkan dan memantau berdasarkan data tenaga kerja sebenar. Setiap tindakan dilaksanakan oleh worker pakar di bawah kebenaran, pengesahan alat, aliran kerja kelulusan dan pengauditan sedia ada.",
      orchestrationHeading: "Orkestrasi",
      specialistWorker: "Worker pakar",
      paused: "Dijeda",
      autonomous: "Autonomi",
      approvalRequired: "Perlu kelulusan",
    },
    orchestration: {
      justNow: "sebentar tadi",
      minAgo: (n) => `${n}m lalu`,
      hAgo: (n) => `${n}j lalu`,
      dAgo: (n) => `${n}h lalu`,
      title: "Pelaksanaan autonomi terkawal",
      subtitle: "Fahami → utamakan → putuskan → laksana melalui alat terkawal sedia ada → pantau.",
      runningCycle: "Kitaran sedang berjalan…",
      runCycleNow: "Jalankan kitaran sekarang",
      autonomyLabel: "Autonomi AI",
      autonomyOff: "Mati — tiada kitaran berjadual",
      autonomyAssisted: "Dibantu — cadangan sahaja",
      autonomyAutonomous: "Autonomi — pelaksanaan terkawal",
      lastCycle: "Kitaran terakhir",
      scheduled: "Berjadual",
      manual: "Manual",
      neverRun: "Belum pernah dijalankan",
      nextEligibleCycle: "Kitaran layak seterusnya",
      autonomyNotEnabled: "Autonomi tidak diaktifkan",
      atNextScheduledTick: "Pada giliran berjadual seterusnya",
      nowAtNextScheduledTick: "Sekarang — pada giliran berjadual seterusnya",
      lastOutcome: "Hasil terakhir",
      dash: "—",
      executedAwaiting: (executed, awaiting) => `${executed} dilaksanakan · ${awaiting} menunggu kelulusan`,
      noCycleYet:
        "Belum ada kitaran orkestrasi dijalankan. Jalankan satu untuk membolehkan eksekutif mengutamakan lead sebenar dan bertindak melalui lapisan alat terkawal.",
      cycleSummary: (rel, considered, attempted, executed, limitReached) =>
        `Kitaran terakhir ${rel} · ${considered} keutamaan dipertimbangkan · ${attempted} tindakan cuba dilaksana · ${executed} berjaya${limitReached ? " · had kitaran dicapai" : ""}`,
      decisionLabel: "Keputusan",
      whyLabel: "Sebab",
      actionLabel: "Tindakan",
      resultLabel: "Hasil",
      noPermittedAction: "Tiada tindakan dibenarkan",
      toastAutonomySet: (mode) => `Autonomi AI ditetapkan kepada ${mode}.`,
      toastAutonomyError: "Tidak dapat menukar mod autonomi.",
      toastCycleFinished: (executed, attempted) =>
        `Kitaran orkestrasi selesai — ${executed} tindakan dilaksanakan daripada ${attempted} cubaan.`,
      toastCycleFailed: "Kitaran orkestrasi gagal.",
      toastCycleFailedFallback: "Kitaran orkestrasi gagal.",
      footerNotice:
        "Setiap tindakan melalui registri alat sedia ada: senarai dibenarkan → skema → kebenaran → peraturan perniagaan → pelaksanaan → audit. Mesej kepada pelanggan tidak pernah dihantar secara autonomi, dan kitaran berhenti selepas bilangan tindakan tetap.",
      statusOrchestrating: "Sedang mengorkestrasi",
      statusFailed: "Gagal",
      statusEscalated: "Dieskalasi",
      statusCompleted: "Selesai",
      statusAdvisory: "Penasihat",
      statusNoActionTaken: "Tiada tindakan diambil",
      statusIdle: "Idle",
      skipped: "Dilangkau",
      autonomyModeAriaLabel: "Mod autonomi AI",
    },
    opportunities: {
      title: "Peluang jualan",
      subtitle: "Dikesan daripada lead langsung, perbualan dan susulan anda",
      detected: (n) => `${n} dikesan`,
      loadError: "Tidak dapat memuatkan peluang jualan. Muat semula untuk cuba lagi.",
      noneDetected: "Tiada peluang jualan aktif dikesan.",
      openLead: "Buka lead",
      openConversation: "Buka perbualan",
      lastContact: (rel) => `Hubungan terakhir ${rel}`,
      neverContacted: "Belum pernah dihubungi",
      viewAllInCrm: "Lihat semua di CRM pipeline",
    },
  },
});
