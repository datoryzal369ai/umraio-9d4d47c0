/**
 * UMRAIO® — public site copy localization (Step 3G.3).
 *
 * PRESENTATION ONLY. This module holds the BM/EN copy for the public
 * marketing surfaces. It consumes the single locale context defined in
 * src/lib/i18n/locale.tsx — it never defines locale state of its own,
 * and it never defines pricing figures (see billing/pricing.core.ts).
 *
 * Brand and technical terms are intentionally kept identical in both
 * languages: UMRAIO®, RAIŌ, RÉNAIO.CORE™, UMRAVERSE®, Autonomous AI
 * Business Executive™, Islamic Implementation Layer™, WhatsApp, AI, API,
 * CRM, Knowledge Base.
 */
import type { Locale } from "@/lib/i18n/locale";

export type Faq = { q: string; a: string };

type SiteCopy = {
  nav: {
    dashboard: string;
    signIn: string;
    signUp: string;
    back: string;
  };
  hero: {
    poweredBy: string;
    kicker: string;
    headingLead: string;
    headingAccent: string;
    subheading: string;
    ctaTrial: string;
    ctaMeet: string;
    ctaDemo: string;
  };
  metrics: {
    sectionLabel: string;
    items: readonly { label: string; micro: string }[];
  };
  showcase: {
    eyebrow: string;
    headingLead: string;
    headingAutomates: string;
    intro: string;
    illustrative: string;
    modules: {
      enquiries: { title: string; body: string; realtime: string; latency: string; typing: string };
      qualify: {
        title: string;
        body: string;
        label: string;
        travelWindow: string;
        pax: string;
        budget: string;
        intent: string;
        intentValue: string;
        leadScore: string;
        qualified: string;
        checks: readonly string[];
      };
      packages: {
        title: string;
        body: string;
        label: string;
        bestMatch: string;
        match: string;
        perPax: string;
        departure: string;
        days: (n: number) => string;
        premiumHotel: string;
      };
      followUp: {
        title: string;
        body: string;
        label: string;
        now: string;
        day: (n: number) => string;
        days: (n: number) => string;
        steps: readonly { title: string; sub: string }[];
        automatedLine1: string;
        automatedLine2: string;
      };
    };
    pipeline: readonly string[];
    closing: string;
  };
  builtForUmrah: { eyebrow: string; heading: string; body1: string; body2: string };
  islamicLayer: {
    eyebrow: string;
    heading: string;
    lede: string;
    body: string;
    cards: readonly { title: string; body: string }[];
    note: string;
  };
  loop: {
    eyebrow: string;
    headingLine1: string;
    headingLine2: string;
    steps: readonly string[];
    body: string;
  };
  trust: { heading: string; body1: string; body2: string };
  governed: {
    eyebrow: string;
    heading: string;
    lede: string;
    card1Title: string;
    card1Body1: string;
    card1Body2: string;
    card2Title: string;
    card2Body1: string;
    card2Body2: string;
    card2Body3: string;
  };
  ladder: {
    eyebrow: string;
    heading: string;
    rows: readonly { tier: string; body: string }[];
  };
  ecosystem: {
    eyebrow: string;
    heading: string;
    lede: string;
    roles: readonly string[];
  };
  closing: { heading: string; body: string; line1: string; line2: string; line3: string };
  faqHeading: string;
  faqs: readonly Faq[];
  footer: {
    tagline: string;
    poweredBy: string;
    governedBy: string;
    governancePillars: string;
    partOf: string;
    ownedBy: string;
    privacy: string;
    terms: string;
    dataDeletion: string;
    rights: string;
  };
  meet: {
    eyebrow: string;
    headingLine1: string;
    headingAccent: string;
    roleLine: string;
    lede: string;
    body: string;
    conversationLabel: string;
    language: string;
    analysing: string;
    inputPlaceholder: string;
    inputLabel: string;
    sendMessage: string;
    snapshotHeading: string;
    snapshotNote: string;
    opportunities: string;
    nothingYet: string;
    diagnosisHeading: string;
    valueBridge: string;
    suggestedDemonstration: string;
    recommendedHeading: string;
    recommendedNote: string;
    flowHeading: string;
    workforceHeading: string;
    upcoming: string;
    active: string;
    convertHeading: string;
    ctaTrial: string;
    ctaDemo: string;
    ctaHuman: string;
    dialog: {
      description: string;
      done: string;
      close: string;
      name: string;
      agencyName: string;
      email: string;
      whatsapp: string;
      agencySize: string;
      agencySizePlaceholder: string;
      monthlyEnquiries: string;
      monthlyEnquiriesPlaceholder: string;
      submit: string;
      failed: string;
      connection: string;
    };
    gapStatus: {
      DETECTED: string;
      ASSESSING: string;
      COVERED: string;
      NOT_YET_ESTABLISHED: string;
    };
  };
};

const EN_FAQS: readonly Faq[] = [
  {
    q: "What is UMRAIO®?",
    a: "UMRAIO® is an AI Autonomous Business Executive built for Umrah agencies. It answers enquiries, qualifies prospects, recommends packages and follows up so your team can focus on closing bookings.",
  },
  {
    q: "Is UMRAIO® a CRM or a chatbot?",
    a: "Neither. UMRAIO® is positioned as an AI Autonomous Business Executive purpose-built for Umrah agencies. It includes a pipeline and messaging, but its role is to execute business workflows — enquiry handling, qualification, package recommendation and follow-up — rather than to act as a generic chatbot or a conventional CRM.",
  },
  {
    q: "What does UMRAIO® do for Umrah agencies?",
    a: "UMRAIO® handles WhatsApp enquiries, qualifies prospects, recommends suitable Umrah packages, follows up with leads and automates repetitive business workflows for agency teams.",
  },
  {
    q: "Who is UMRAIO® for?",
    a: "Licensed Umrah and travel agencies — primarily in Malaysia — that handle enquiries over WhatsApp and want to convert more of them into bookings.",
  },
  {
    q: "How does UMRAIO® work with WhatsApp?",
    a: "You connect your WhatsApp Business number in settings. UMRAIO® then replies to incoming messages in Bahasa Malaysia or English, using your agency's packages and knowledge base.",
  },
  {
    q: "Can UMRAIO® capture and follow up with leads?",
    a: "Yes. Every conversation is captured as a lead with budget, pax, travel window and intent, then scored and placed in your CRM pipeline with scheduled follow-ups.",
  },
  {
    q: "What is the Islamic Implementation Layer™?",
    a: "It is an architectural layer designed to connect relevant Islamic principles, halal baselines, ethical business practices and governance requirements with AI-assisted workflows and operational execution.",
  },
  {
    q: "Is UMRAIO® a Shariah authority?",
    a: "No. UMRAIO® is an AI business intelligence and automation platform. It does not issue fatwa or replace qualified Islamic scholars. Relevant Shariah matters remain subject to appropriate human expertise and governance.",
  },
  {
    q: "Is UMRAIO® Halal or JAKIM certified?",
    a: "UMRAIO® should not be represented as formally Halal or JAKIM certified unless and until the appropriate authority grants such recognition. The platform is designed with Shariah-aware and halal-oriented implementation principles for relevant Umrah workflows.",
  },
  {
    q: "Does UMRAIO® replace human sales consultants?",
    a: "No. UMRAIO® automates repetitive business workflows and assists sales teams while preserving human judgement, approval and relationship management.",
  },
  {
    q: "What is RÉNAIO.CORE™?",
    a: "RÉNAIO.CORE™ (RENAIO.CORE™) is the Autonomous Intelligence Core powering the Digital Renaissance ecosystem and its AI-native platforms. UMRAIO® is the AI Autonomous Business Executive for Umrah agencies built within that intelligence architecture — it is a separate product, not the core itself.",
  },
  {
    q: "What powers UMRAIO®?",
    a: "RÉNAIO.CORE™ provides the autonomous intelligence layer that powers UMRAIO®, the Islamic Implementation Layer™ adds principles and governance context, and UMRAVERSE® provides the Umrah ecosystem, knowledge, business and customer context. UMRAIO® is the AI autonomous business executive built for modern Umrah agencies.",
  },
];

const BM_FAQS: readonly Faq[] = [
  {
    q: "Apa itu UMRAIO®?",
    a: "UMRAIO® ialah AI Autonomous Business Executive yang dibina khas untuk agensi Umrah. Ia menjawab pertanyaan, menapis prospek, mencadangkan pakej dan membuat susulan supaya pasukan anda boleh fokus untuk menutup tempahan.",
  },
  {
    q: "Adakah UMRAIO® sebuah CRM atau chatbot?",
    a: "Kedua-duanya tidak. UMRAIO® diposisikan sebagai AI Autonomous Business Executive yang dibina khusus untuk agensi Umrah. Ia mempunyai pipeline dan mesej, tetapi peranannya adalah melaksanakan aliran kerja perniagaan — pengendalian pertanyaan, penapisan prospek, cadangan pakej dan susulan — bukan sekadar chatbot biasa atau CRM konvensional.",
  },
  {
    q: "Apa yang UMRAIO® lakukan untuk agensi Umrah?",
    a: "UMRAIO® mengendalikan pertanyaan WhatsApp, menapis prospek, mencadangkan pakej Umrah yang sesuai, membuat susulan dengan lead dan mengautomasikan kerja berulang untuk pasukan agensi.",
  },
  {
    q: "UMRAIO® untuk siapa?",
    a: "Agensi Umrah dan pelancongan berlesen — terutamanya di Malaysia — yang menerima pertanyaan melalui WhatsApp dan mahu menukar lebih banyak pertanyaan kepada tempahan.",
  },
  {
    q: "Bagaimana UMRAIO® berfungsi dengan WhatsApp?",
    a: "Anda sambungkan nombor WhatsApp Business anda di tetapan. UMRAIO® kemudian membalas mesej masuk dalam Bahasa Melayu atau English, menggunakan pakej dan Knowledge Base agensi anda.",
  },
  {
    q: "Bolehkah UMRAIO® merekod dan membuat susulan lead?",
    a: "Boleh. Setiap perbualan direkod sebagai lead lengkap dengan bajet, jumlah pax, tarikh perjalanan dan niat pembelian, kemudian diberi skor dan dimasukkan ke dalam pipeline CRM dengan susulan berjadual.",
  },
  {
    q: "Apa itu Islamic Implementation Layer™?",
    a: "Ia adalah lapisan seni bina yang menghubungkan prinsip Islam yang berkaitan, asas halal, amalan perniagaan beretika dan keperluan tadbir urus dengan aliran kerja berbantukan AI dan pelaksanaan operasi.",
  },
  {
    q: "Adakah UMRAIO® satu autoriti Syariah?",
    a: "Tidak. UMRAIO® ialah platform kecerdasan perniagaan dan automasi AI. Ia tidak mengeluarkan fatwa dan tidak menggantikan ulama yang bertauliah. Perkara Syariah kekal tertakluk kepada kepakaran manusia dan tadbir urus yang sewajarnya.",
  },
  {
    q: "Adakah UMRAIO® diperakui Halal atau JAKIM?",
    a: "UMRAIO® tidak boleh digambarkan sebagai diperakui Halal atau JAKIM secara rasmi selagi pengiktirafan tersebut belum diberikan oleh pihak berkuasa berkenaan. Platform ini direka dengan prinsip pelaksanaan yang mesra Syariah dan berorientasikan halal untuk aliran kerja Umrah yang berkaitan.",
  },
  {
    q: "Adakah UMRAIO® menggantikan perunding jualan manusia?",
    a: "Tidak. UMRAIO® mengautomasikan kerja perniagaan berulang dan membantu pasukan jualan, sambil mengekalkan pertimbangan, kelulusan dan hubungan pelanggan di tangan manusia.",
  },
  {
    q: "Apa itu RÉNAIO.CORE™?",
    a: "RÉNAIO.CORE™ (RENAIO.CORE™) ialah Autonomous Intelligence Core yang menggerakkan ekosistem Digital Renaissance dan platform AI-native di dalamnya. UMRAIO® pula ialah AI Autonomous Business Executive untuk agensi Umrah yang dibina di atas seni bina kecerdasan tersebut — ia produk berasingan, bukan core itu sendiri.",
  },
  {
    q: "Apa yang menggerakkan UMRAIO®?",
    a: "RÉNAIO.CORE™ menyediakan lapisan kecerdasan autonomi yang menggerakkan UMRAIO®, Islamic Implementation Layer™ menambah prinsip dan konteks tadbir urus, manakala UMRAVERSE® menyediakan konteks ekosistem, ilmu, perniagaan dan pelanggan Umrah. UMRAIO® ialah AI autonomous business executive untuk agensi Umrah moden.",
  },
];

export const SITE_COPY: Record<Locale, SiteCopy> = {
  en: {
    nav: { dashboard: "Dashboard", signIn: "Sign In", signUp: "Sign Up", back: "Back" },
    hero: {
      poweredBy: "Powered by",
      kicker: "AI Autonomous Business Executive",
      headingLead: "Your AI Autonomous Business Executive for",
      headingAccent: "Modern Umrah Agencies",
      subheading:
        "UMRAIO® combines autonomous AI execution, Umrah domain intelligence, customer context and governed workflows — with an Islamic Implementation Layer™ designed for the specific requirements of the Umrah ecosystem.",
      ctaTrial: "Choose a Plan",
      ctaMeet: "Meet Your AI Business Executive™",
      ctaDemo: "Book Live Demo",
    },
    metrics: {
      sectionLabel: "UMRAIO AI workforce capabilities",
      items: [
        { label: "Always working", micro: "Your AI workforce never sleeps." },
        { label: "Instant replies", micro: "Enquiries answered the moment they arrive." },
        { label: "Follow-up automated", micro: "Repetitive work runs itself." },
        { label: "Governed autonomy", micro: "Reasoned decisions, not scripted replies." },
      ],
    },
    showcase: {
      eyebrow: "The autonomous AI workforce",
      headingLead: "What",
      headingAutomates: "Automates",
      intro:
        "From the first WhatsApp message to the next best action — UMRAIO® keeps your agency moving.",
      illustrative: "Illustrative demonstration",
      modules: {
        enquiries: {
          title: "Answers enquiries",
          body: "Responds instantly using your agency knowledge base, package information, customer context and Umrah-specific intelligence.",
          realtime: "Real-time AI",
          latency: "AI response < 1 sec",
          typing: "UMRAIO AI is typing…",
        },
        qualify: {
          title: "Qualifies prospects",
          body: "Understands travel intent, pax, budget, timing and customer needs while operating within defined agency policies.",
          label: "Lead intelligence",
          travelWindow: "Travel window",
          pax: "Pax",
          budget: "Budget",
          intent: "Intent",
          intentValue: "High",
          leadScore: "Lead score",
          qualified: "QUALIFIED",
          checks: [
            "Budget identified",
            "Travel date identified",
            "Pax identified",
            "Purchase intent detected",
          ],
        },
        packages: {
          title: "Recommends packages",
          body: "Matches customer requirements with relevant Umrah packages and available agency information.",
          label: "Package match",
          bestMatch: "Best match",
          match: "Match",
          perPax: "/ pax",
          departure: "Departure",
          days: (n) => `${n} Days`,
          premiumHotel: "Premium Hotel",
        },
        followUp: {
          title: "Follows up",
          body: "Runs structured follow-up while respecting customer preferences, agency policies and responsible communication practices.",
          label: "Automated follow-up",
          now: "Now",
          day: (n) => `+${n} day`,
          days: (n) => `+${n} days`,
          steps: [
            { title: "Initial enquiry", sub: "Message received" },
            { title: "Package reminder", sub: "Automated WhatsApp message" },
            { title: "Personalised follow-up", sub: "AI personalised message" },
            { title: "Final follow-up", sub: "Last touch before closing" },
          ],
          automatedLine1: "Follow-up",
          automatedLine2: "automated",
        },
      },
      pipeline: ["Enquiry", "Qualification", "Recommendation", "Follow-up", "Conversion"],
      closing:
        "doesn't just answer leads. It understands them, acts on them and keeps moving the conversation forward.",
    },
    builtForUmrah: {
      eyebrow: "What makes UMRAIO® different",
      heading: "Built for Umrah — not generic business automation.",
      body1:
        "UMRAIO® is designed around the realities of Umrah agencies: enquiries, qualification, package discovery, sales conversations, follow-up, customer trust and operational execution.",
      body2:
        "Unlike generic AI automation, UMRAIO combines business intelligence with Umrah-specific context and governed Islamic implementation.",
    },
    islamicLayer: {
      eyebrow: "Architecture layer",
      heading: "Islamic Implementation Layer",
      lede: "From Islamic principles to responsible Umrah operations.",
      body: "UMRAIO® is designed to support relevant Islamic principles, halal considerations, ethical business practices and governance requirements within Umrah-related workflows.",
      cards: [
        {
          title: "Shariah-aware context",
          body: "Relevant Islamic principles and domain considerations can inform applicable customer, product and business workflows.",
        },
        {
          title: "Halal baseline",
          body: "A structured baseline for relevant Umrah products, services, offers and operational processes.",
        },
        {
          title: "Islamic business implementation",
          body: "Translate relevant principles and ethical requirements into practical workflows, policies and responsible business practices.",
        },
        {
          title: "Governed AI execution",
          body: "AI actions operate within defined business rules, agency policies, human oversight and escalation controls.",
        },
      ],
      note: "Relevant Shariah and sensitive domain matters remain subject to appropriate governance and expert oversight.",
    },
    loop: {
      eyebrow: "The UMRAIO® intelligence loop",
      headingLine1: "Intelligence determines what can be done.",
      headingLine2: "Governance determines how it should be done.",
      steps: ["Understand", "Reason", "Recommend", "Execute", "Follow up", "Learn"],
      body: "Islamic Implementation adds principles and governance context to the operational intelligence layer.",
    },
    trust: {
      heading: "Umrah is not an ordinary transaction.",
      body1:
        "Umrah customers are making decisions involving trust, faith, family, finances and travel. That requires more than generic automation.",
      body2: "UMRAIO® is designed to operate within that context.",
    },
    governed: {
      eyebrow: "Autonomy with oversight",
      heading: "Governed autonomy",
      lede: "An autonomous business executive that understands your agency, your customers, your packages and your sales workflow.",
      card1Title: "Autonomous does not mean uncontrolled",
      card1Body1:
        "UMRAIO® is designed to operate within defined agency rules, knowledge boundaries, approval controls, escalation paths and human oversight.",
      card1Body2:
        "For Islamic and sensitive domain matters, appropriate human and qualified expert oversight remains essential.",
      card2Title: "Human + AI",
      card2Body1:
        "UMRAIO® does not replace agency owners, sales consultants, operations teams or qualified Islamic scholars.",
      card2Body2:
        "UMRAIO handles repetitive intelligence and execution so humans can focus on judgement, relationships, exceptions and high-value decisions.",
      card2Body3:
        "From first enquiry to follow-up, UMRAIO® helps your team move faster without removing human judgement where it matters.",
    },
    ladder: {
      eyebrow: "Where UMRAIO® sits",
      heading: "From storing data to executing business",
      rows: [
        { tier: "Generic CRM", body: "Stores information." },
        { tier: "AI chatbot", body: "Answers questions." },
        { tier: "AI assistant", body: "Helps humans." },
        { tier: "AI agent", body: "Executes tasks." },
        { tier: "Vertical AI", body: "Understands a domain." },
        {
          tier: "UMRAIO®",
          body: "Understands Umrah context, reasons, recommends, executes and follows up.",
        },
        {
          tier: "UMRAIO® with Islamic Implementation",
          body: "Adds relevant Islamic principles, halal baseline, ethical governance and responsible implementation context.",
        },
      ],
    },
    ecosystem: {
      eyebrow: "Architecture",
      heading: "How UMRAIO® fits the ecosystem",
      lede: "UMRAVERSE® is the ecosystem and domain intelligence layer. UMRAIO® is the autonomous business executive operating within that ecosystem.",
      roles: [
        "Ecosystem architect",
        "Autonomous intelligence core",
        "Principles • Halal • Ethics • Governance • Implementation",
        "Umrah digital ecosystem",
        "Autonomous AI business executive",
        "Business outcomes",
      ],
    },
    closing: {
      heading: "AI for Umrah is no longer just about answering questions.",
      body: "UMRAIO® brings autonomous intelligence into the real business workflow — from enquiry to conversion and follow-up.",
      line1: "Built for Umrah.",
      line2: "Powered by autonomous intelligence.",
      line3: "Designed with responsible Islamic implementation.",
    },
    faqHeading: "Frequently Asked Questions",
    faqs: EN_FAQS,
    footer: {
      tagline: "AI Autonomous Business Executive",
      poweredBy: "Powered by",
      governedBy: "Governed by",
      governancePillars: "Principles • Halal • Ethics • Governance",
      partOf: "Part of",
      ownedBy: "Developed and owned by",
      privacy: "Privacy Policy",
      terms: "Terms of Service",
      dataDeletion: "Data Deletion",
      rights: "All rights reserved.",
    },
    meet: {
      eyebrow: "Meet your AI Executive",
      headingLine1: "Autonomous AI",
      headingAccent: "Business Executive",
      roleLine: "The AI Autonomous Business Executive™",
      lede: "Your intelligent AI executive for modern Umrah agencies.",
      body: "Tell RAIŌ how your agency works. RAIŌ will understand your workflow, identify opportunities and show you where UMRAIO can help your agency sell, follow up and grow.",
      conversationLabel: "Conversation",
      language: "Language",
      analysing: "Analysing your workflow…",
      inputPlaceholder: "Tell RAIŌ how your agency works…",
      inputLabel: "Tell RAIŌ how your agency works",
      sendMessage: "Send message",
      snapshotHeading: "UMRAIO business opportunity snapshot",
      snapshotNote:
        "Derived only from what you tell the executive. Nothing is estimated or invented.",
      opportunities: "Opportunities detected",
      nothingYet:
        "Nothing established yet — tell the executive how your agency handles enquiries and this will update live.",
      diagnosisHeading: "Your UMRAIO business diagnosis™",
      valueBridge: "Value bridge",
      suggestedDemonstration: "Suggested demonstration",
      recommendedHeading: "Recommended UMRAIO capabilities",
      recommendedNote:
        "These capabilities are designed to work together as an autonomous AI workforce rather than as isolated tools, subject to appropriate governance.",
      flowHeading: "How UMRAIO would execute",
      workforceHeading: "The AI workforce",
      upcoming: "Upcoming",
      active: "Active",
      convertHeading: "Ready to see UMRAIO working with your agency?",
      ctaTrial: "Choose a Plan",
      ctaDemo: "Book Live Demo",
      ctaHuman: "Talk to our team",
      dialog: {
        description:
          "Share only what our team needs to contact you. Your details are recorded for this request.",
        done: "Your request has been recorded. Our team will contact you using the details you provided.",
        close: "Close",
        name: "Name",
        agencyName: "Agency name",
        email: "Email",
        whatsapp: "WhatsApp",
        agencySize: "Agency size",
        agencySizePlaceholder: "e.g. 8 staff",
        monthlyEnquiries: "Monthly enquiries",
        monthlyEnquiriesPlaceholder: "e.g. 300",
        submit: "Submit request",
        failed: "We could not record your request. Please try again.",
        connection: "Connection problem. Please try again.",
      },
      gapStatus: {
        DETECTED: "Detected",
        ASSESSING: "Assessing",
        COVERED: "Covered",
        NOT_YET_ESTABLISHED: "Not yet established",
      },
    },
  },

  bm: {
    nav: { dashboard: "Dashboard", signIn: "Log Masuk", signUp: "Daftar", back: "Kembali" },
    hero: {
      poweredBy: "Dikuasakan oleh",
      kicker: "AI Autonomous Business Executive",
      headingLead: "AI Autonomous Business Executive Anda untuk",
      headingAccent: "Agensi Umrah Moden",
      subheading:
        "UMRAIO® menggabungkan pelaksanaan AI autonomi, kecerdasan domain Umrah, konteks pelanggan dan aliran kerja bertadbir urus — bersama Islamic Implementation Layer™ yang direka khusus untuk keperluan ekosistem Umrah.",
      ctaTrial: "Daftar & Pilih Pelan",
      ctaMeet: "Jumpa AI Business Executive™",
      ctaDemo: "Tempah Demo Langsung",
    },
    metrics: {
      sectionLabel: "Keupayaan tenaga kerja AI UMRAIO",
      items: [
        { label: "Sentiasa bekerja", micro: "Tenaga kerja AI anda tidak pernah tidur." },
        { label: "Respons segera", micro: "Pertanyaan dijawab sebaik ia masuk." },
        { label: "Susulan automatik", micro: "Kerja berulang berjalan sendiri." },
        { label: "Autonomi ditadbir", micro: "Keputusan bernalar, bukan jawapan skrip." },
      ],
    },
    showcase: {
      eyebrow: "Tenaga kerja AI autonomi",
      headingLead: "Apa yang",
      headingAutomates: "Automasikan",
      intro:
        "Dari mesej WhatsApp pertama sehingga tindakan terbaik seterusnya — UMRAIO® memastikan agensi anda terus bergerak.",
      illustrative: "Paparan ilustrasi",
      modules: {
        enquiries: {
          title: "Menjawab pertanyaan",
          body: "Membalas serta-merta menggunakan Knowledge Base agensi anda, maklumat pakej, konteks pelanggan dan kecerdasan khusus Umrah.",
          realtime: "AI masa nyata",
          latency: "Respons AI < 1 saat",
          typing: "UMRAIO AI sedang menaip…",
        },
        qualify: {
          title: "Menapis prospek",
          body: "Memahami niat perjalanan, jumlah pax, bajet, masa dan keperluan pelanggan sambil beroperasi dalam polisi agensi yang ditetapkan.",
          label: "Kecerdasan lead",
          travelWindow: "Tarikh perjalanan",
          pax: "Pax",
          budget: "Bajet",
          intent: "Niat",
          intentValue: "Tinggi",
          leadScore: "Skor lead",
          qualified: "LAYAK",
          checks: [
            "Bajet dikenal pasti",
            "Tarikh perjalanan dikenal pasti",
            "Jumlah pax dikenal pasti",
            "Niat pembelian dikesan",
          ],
        },
        packages: {
          title: "Mencadangkan pakej",
          body: "Memadankan keperluan pelanggan dengan pakej Umrah yang berkaitan dan maklumat agensi yang tersedia.",
          label: "Padanan pakej",
          bestMatch: "Padanan terbaik",
          match: "Padanan",
          perPax: "/ pax",
          departure: "Berlepas",
          days: (n) => `${n} Hari`,
          premiumHotel: "Hotel Premium",
        },
        followUp: {
          title: "Membuat susulan",
          body: "Menjalankan susulan berstruktur sambil menghormati pilihan pelanggan, polisi agensi dan amalan komunikasi yang bertanggungjawab.",
          label: "Susulan automatik",
          now: "Sekarang",
          day: (n) => `+${n} hari`,
          days: (n) => `+${n} hari`,
          steps: [
            { title: "Pertanyaan pertama", sub: "Mesej diterima" },
            { title: "Peringatan pakej", sub: "Mesej WhatsApp automatik" },
            { title: "Susulan peribadi", sub: "Mesej diperibadikan oleh AI" },
            { title: "Susulan akhir", sub: "Sentuhan terakhir sebelum tutup" },
          ],
          automatedLine1: "Susulan",
          automatedLine2: "automatik",
        },
      },
      pipeline: ["Pertanyaan", "Penapisan", "Cadangan", "Susulan", "Penukaran"],
      closing:
        "bukan sekadar menjawab lead. Ia memahami lead, bertindak ke atasnya dan terus menggerakkan perbualan ke hadapan.",
    },
    builtForUmrah: {
      eyebrow: "Apa yang membezakan UMRAIO®",
      heading: "Dibina untuk Umrah — bukan automasi perniagaan generik.",
      body1:
        "UMRAIO® direka mengikut realiti agensi Umrah: pertanyaan, penapisan prospek, pencarian pakej, perbualan jualan, susulan, kepercayaan pelanggan dan pelaksanaan operasi.",
      body2:
        "Berbeza dengan automasi AI generik, UMRAIO menggabungkan kecerdasan perniagaan dengan konteks khusus Umrah dan pelaksanaan Islam yang bertadbir urus.",
    },
    islamicLayer: {
      eyebrow: "Lapisan seni bina",
      heading: "Islamic Implementation Layer",
      lede: "Daripada prinsip Islam kepada operasi Umrah yang bertanggungjawab.",
      body: "UMRAIO® direka untuk menyokong prinsip Islam yang berkaitan, pertimbangan halal, amalan perniagaan beretika dan keperluan tadbir urus dalam aliran kerja berkaitan Umrah.",
      cards: [
        {
          title: "Konteks mesra Syariah",
          body: "Prinsip Islam dan pertimbangan domain yang berkaitan boleh memandu aliran kerja pelanggan, produk dan perniagaan yang berkenaan.",
        },
        {
          title: "Asas halal",
          body: "Asas berstruktur untuk produk, perkhidmatan, tawaran dan proses operasi Umrah yang berkaitan.",
        },
        {
          title: "Pelaksanaan perniagaan Islam",
          body: "Menterjemah prinsip dan keperluan etika yang berkaitan kepada aliran kerja, polisi dan amalan perniagaan yang bertanggungjawab.",
        },
        {
          title: "Pelaksanaan AI bertadbir urus",
          body: "Tindakan AI beroperasi dalam peraturan perniagaan, polisi agensi, pengawasan manusia dan kawalan eskalasi yang ditetapkan.",
        },
      ],
      note: "Perkara Syariah dan domain sensitif yang berkaitan kekal tertakluk kepada tadbir urus dan pengawasan pakar yang sewajarnya.",
    },
    loop: {
      eyebrow: "Kitaran kecerdasan UMRAIO®",
      headingLine1: "Kecerdasan menentukan apa yang boleh dilakukan.",
      headingLine2: "Tadbir urus menentukan bagaimana ia patut dilakukan.",
      steps: ["Faham", "Nilai", "Cadang", "Laksana", "Susulan", "Belajar"],
      body: "Islamic Implementation menambah prinsip dan konteks tadbir urus kepada lapisan kecerdasan operasi.",
    },
    trust: {
      heading: "Umrah bukan transaksi biasa.",
      body1:
        "Pelanggan Umrah membuat keputusan yang melibatkan kepercayaan, iman, keluarga, kewangan dan perjalanan. Itu memerlukan lebih daripada automasi generik.",
      body2: "UMRAIO® direka untuk beroperasi dalam konteks tersebut.",
    },
    governed: {
      eyebrow: "Autonomi dengan pengawasan",
      heading: "Autonomi bertadbir urus",
      lede: "Autonomous business executive yang memahami agensi anda, pelanggan anda, pakej anda dan aliran kerja jualan anda.",
      card1Title: "Autonomi bukan bermakna tiada kawalan",
      card1Body1:
        "UMRAIO® direka untuk beroperasi dalam peraturan agensi, sempadan pengetahuan, kawalan kelulusan, laluan eskalasi dan pengawasan manusia yang ditetapkan.",
      card1Body2:
        "Bagi perkara Islam dan domain sensitif, pengawasan manusia dan pakar bertauliah kekal penting.",
      card2Title: "Manusia + AI",
      card2Body1:
        "UMRAIO® tidak menggantikan pemilik agensi, perunding jualan, pasukan operasi atau ulama bertauliah.",
      card2Body2:
        "UMRAIO mengendalikan kerja berulang dan pelaksanaan supaya manusia boleh fokus pada pertimbangan, hubungan, kes khas dan keputusan bernilai tinggi.",
      card2Body3:
        "Dari pertanyaan pertama hingga susulan, UMRAIO® membantu pasukan anda bergerak lebih pantas tanpa menghilangkan pertimbangan manusia di tempat yang penting.",
    },
    ladder: {
      eyebrow: "Di mana kedudukan UMRAIO®",
      heading: "Daripada menyimpan data kepada melaksanakan perniagaan",
      rows: [
        { tier: "CRM generik", body: "Menyimpan maklumat." },
        { tier: "AI chatbot", body: "Menjawab soalan." },
        { tier: "AI assistant", body: "Membantu manusia." },
        { tier: "AI agent", body: "Melaksanakan tugasan." },
        { tier: "Vertical AI", body: "Memahami satu domain." },
        {
          tier: "UMRAIO®",
          body: "Memahami konteks Umrah, menilai, mencadang, melaksana dan membuat susulan.",
        },
        {
          tier: "UMRAIO® dengan Islamic Implementation",
          body: "Menambah prinsip Islam yang berkaitan, asas halal, tadbir urus beretika dan konteks pelaksanaan yang bertanggungjawab.",
        },
      ],
    },
    ecosystem: {
      eyebrow: "Seni bina",
      heading: "Bagaimana UMRAIO® berada dalam ekosistem",
      lede: "UMRAVERSE® ialah lapisan ekosistem dan kecerdasan domain. UMRAIO® pula ialah autonomous business executive yang beroperasi dalam ekosistem tersebut.",
      roles: [
        "Arkitek ekosistem",
        "Teras kecerdasan autonomi",
        "Prinsip • Halal • Etika • Tadbir Urus • Pelaksanaan",
        "Ekosistem digital Umrah",
        "Autonomous AI business executive",
        "Hasil perniagaan",
      ],
    },
    closing: {
      heading: "AI untuk Umrah bukan lagi sekadar menjawab soalan.",
      body: "UMRAIO® membawa kecerdasan autonomi ke dalam aliran kerja perniagaan sebenar — daripada pertanyaan hingga penukaran dan susulan.",
      line1: "Dibina untuk Umrah.",
      line2: "Dikuasakan oleh kecerdasan autonomi.",
      line3: "Direka dengan pelaksanaan Islam yang bertanggungjawab.",
    },
    faqHeading: "Soalan Lazim",
    faqs: BM_FAQS,
    footer: {
      tagline: "AI Autonomous Business Executive",
      poweredBy: "Dikuasakan oleh",
      governedBy: "Ditadbir oleh",
      governancePillars: "Prinsip • Halal • Etika • Tadbir Urus",
      partOf: "Sebahagian daripada",
      ownedBy: "Dibangun dan dimiliki oleh",
      privacy: "Dasar Privasi",
      terms: "Terma Perkhidmatan",
      dataDeletion: "Pemadaman Data",
      rights: "Hak cipta terpelihara.",
    },
    meet: {
      eyebrow: "Jumpa AI Executive anda",
      headingLine1: "Autonomous AI",
      headingAccent: "Business Executive",
      roleLine: "The AI Autonomous Business Executive™",
      lede: "AI executive pintar anda untuk agensi Umrah moden.",
      body: "Beritahu RAIŌ bagaimana agensi anda beroperasi. RAIŌ akan memahami aliran kerja anda, mengenal pasti peluang dan menunjukkan di mana UMRAIO boleh membantu agensi anda menjual, membuat susulan dan berkembang.",
      conversationLabel: "Perbualan",
      language: "Bahasa",
      analysing: "Sedang menganalisis aliran kerja anda…",
      inputPlaceholder: "Beritahu RAIŌ bagaimana agensi anda beroperasi…",
      inputLabel: "Beritahu RAIŌ bagaimana agensi anda beroperasi",
      sendMessage: "Hantar mesej",
      snapshotHeading: "Gambaran peluang perniagaan UMRAIO",
      snapshotNote:
        "Diperoleh hanya daripada apa yang anda beritahu executive. Tiada anggaran atau rekaan.",
      opportunities: "Peluang dikesan",
      nothingYet:
        "Belum ada maklumat — beritahu executive bagaimana agensi anda mengendalikan pertanyaan dan bahagian ini akan dikemas kini secara langsung.",
      diagnosisHeading: "Diagnosis perniagaan UMRAIO anda™",
      valueBridge: "Jambatan nilai",
      suggestedDemonstration: "Cadangan demonstrasi",
      recommendedHeading: "Keupayaan UMRAIO yang disyorkan",
      recommendedNote:
        "Keupayaan ini direka untuk bekerja bersama sebagai satu tenaga kerja AI autonomi, bukan sebagai alat berasingan, tertakluk kepada tadbir urus yang sewajarnya.",
      flowHeading: "Bagaimana UMRAIO akan melaksanakannya",
      workforceHeading: "Tenaga kerja AI",
      upcoming: "Akan datang",
      active: "Aktif",
      convertHeading: "Bersedia untuk melihat UMRAIO bekerja dengan agensi anda?",
      ctaTrial: "Daftar & Pilih Pelan",
      ctaDemo: "Tempah Demo Langsung",
      ctaHuman: "Hubungi pasukan kami",
      dialog: {
        description:
          "Kongsi maklumat yang diperlukan sahaja supaya pasukan kami boleh menghubungi anda. Butiran anda direkod untuk permintaan ini.",
        done: "Permintaan anda telah direkod. Pasukan kami akan menghubungi anda menggunakan butiran yang diberikan.",
        close: "Tutup",
        name: "Nama",
        agencyName: "Nama agensi",
        email: "Emel",
        whatsapp: "WhatsApp",
        agencySize: "Saiz agensi",
        agencySizePlaceholder: "cth. 8 staf",
        monthlyEnquiries: "Pertanyaan sebulan",
        monthlyEnquiriesPlaceholder: "cth. 300",
        submit: "Hantar permintaan",
        failed: "Kami tidak dapat merekod permintaan anda. Sila cuba lagi.",
        connection: "Masalah sambungan. Sila cuba lagi.",
      },
      gapStatus: {
        DETECTED: "Dikesan",
        ASSESSING: "Sedang dinilai",
        COVERED: "Sudah ada",
        NOT_YET_ESTABLISHED: "Belum ditetapkan",
      },
    },
  },
};

/** Copy for the active locale. */
export function siteCopy(locale: Locale): SiteCopy {
  return SITE_COPY[locale];
}

/** Canonical English FAQ set used for structured data (schema.org) only. */
export const SCHEMA_FAQS = EN_FAQS;
