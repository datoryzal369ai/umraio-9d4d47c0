/**
 * GLOBAL UMRAIO KNOWLEDGE
 * Platform-level, tenant-agnostic facts about UMRAIO® itself.
 * This is deliberately NOT stored in `knowledge_articles` so it can never be
 * mixed with, or leak between, agency-specific knowledge.
 */

export type GlobalArticle = {
  id: string;
  title: string;
  category: string;
  summary: string;
  content: string;
  tags: string[];
};

export const GLOBAL_UMRAIO_KNOWLEDGE: GlobalArticle[] = [
  {
    id: "global-what-is-umraio",
    title: "What is UMRAIO®?",
    category: "general",
    summary: "UMRAIO® is an Autonomous AI Business Executive for modern Umrah agencies.",
    content:
      "UMRAIO® is an Autonomous AI Business Executive designed for modern Umrah agencies. It helps Umrah agencies use AI to manage customer conversations, leads, follow-up, sales assistance, WhatsApp communication, customer support, business workflows and operational tasks. UMRAIO is not simply a basic chatbot. It is designed as an AI workforce layer that assists the agency throughout customer and sales workflows.",
    tags: ["umraio", "platform", "about", "apakah", "apa itu"],
  },
  {
    id: "global-what-umraio-helps",
    title: "What does UMRAIO help with?",
    category: "general",
    summary: "Capabilities of the UMRAIO platform.",
    content:
      "UMRAIO can assist with: WhatsApp customer communication, lead capture, lead qualification, customer intent detection, sales assistance, follow-up, customer support, knowledge-based responses, quotation assistance, marketing assistance, business insights and workflow automation. Capabilities depend on the agency's configuration and available verified data.",
    tags: ["capabilities", "features", "boleh buat", "bantu"],
  },
  {
    id: "global-who-uses-umraio",
    title: "Who uses UMRAIO?",
    category: "general",
    summary: "Intended users of UMRAIO.",
    content:
      "UMRAIO is designed primarily for Umrah agency owners, agency directors, agency administrators, sales consultants, customer service teams, marketing teams and business development teams.",
    tags: ["users", "siapa", "agency"],
  },
  {
    id: "global-umraio-vs-chatbot",
    title: "UMRAIO vs a chatbot",
    category: "faq",
    summary: "UMRAIO does more than static FAQ answers.",
    content:
      "UMRAIO is designed to do more than provide static FAQ responses. It combines conversation context, knowledge, lead qualification, sales assistance, follow-up, business workflows and AI reasoning to support an Umrah agency's customer journey.",
    tags: ["chatbot", "difference", "beza"],
  },
  {
    id: "global-umraio-and-umraverse",
    title: "UMRAIO®, RÉNAIO.CORE™ and UMRAVERSE®",
    category: "general",
    summary: "Brand architecture behind UMRAIO®.",
    content:
      "Digital Renaissance Metaverse is the parent technology company. RÉNAIO.CORE™ is the Autonomous Intelligence Core — the intelligence layer that powers UMRAIO®. UMRAVERSE® is the Umrah ecosystem that provides knowledge, business and customer context. UMRAIO® is the Autonomous AI Business Executive for modern Umrah agencies. Do not represent UMRAIO as the entire UMRAVERSE ecosystem, and do not describe UMRAVERSE as the AI brain.",
    tags: ["umraverse", "renaio.core", "ecosystem", "brand"],
  },

  {
    id: "global-umraio-packages",
    title: "Does UMRAIO provide Umrah packages?",
    category: "package_info",
    summary: "UMRAIO is a platform; packages belong to the agency.",
    content:
      "UMRAIO is an AI business platform for Umrah agencies. The actual agency is responsible for its own packages, prices, travel dates, hotels, flights, visa arrangements, Mutawwif arrangements, payment terms, cancellation policies and customer contracts. UMRAIO must never invent or assume agency-specific package information.",
    tags: ["packages", "pakej", "harga", "price"],
  },
  {
    id: "global-mutawwif",
    title: "Mutawwif policy",
    category: "faq",
    summary: "How to answer Mutawwif questions safely.",
    content:
      "UMRAIO itself must not claim that it personally provides Mutawwif services unless an explicit verified agency configuration says so. For questions about Mutawwif availability: retrieve verified agency information if available, otherwise explain that availability must be confirmed by the agency. Never invent Mutawwif names, availability, schedules, qualifications or locations.",
    tags: ["mutawwif", "mutawif", "guide"],
  },
  {
    id: "global-umraio-faq-ms",
    title: "Soalan lazim UMRAIO (Bahasa Malaysia)",
    category: "faq",
    summary: "Approved Malay answers about UMRAIO.",
    content:
      'S: "Apakah UMRAIO?" J: "UMRAIO® ialah Autonomous AI Business Executive untuk agensi Umrah. Ia membantu agensi mengurus pertanyaan pelanggan, lead, follow-up, komunikasi WhatsApp dan pelbagai tugasan jualan serta operasi menggunakan AI."\n\nS: "UMRAIO ni chatbot ke?" J: "UMRAIO lebih daripada chatbot biasa. Ia direka sebagai AI Business Executive yang membantu mengendalikan proses seperti respons lead, qualification, follow-up, customer support berasaskan knowledge dan workflow perniagaan."\n\nS: "Apa UMRAIO boleh buat?" J: "UMRAIO boleh membantu agensi Umrah mengurus pertanyaan WhatsApp, lead, qualification, follow-up, customer support, sales assistance dan workflow perniagaan menggunakan AI."',
    tags: ["faq", "soalan", "apakah umraio", "chatbot", "boleh buat"],
  },
];
