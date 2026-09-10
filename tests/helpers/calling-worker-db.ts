/** In-memory tenant-aware PostgREST fixture; no live database or sender. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function callingDb(overrides: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    whatsapp_call_sessions: [{ id: "session", agency_id: "agency", call_id: "synthetic-call", caller_phone: "60123456789", status: "answered", meta_accepted_at: "2026-09-10T00:00:00Z", transcript: [], turn_count: 0, detected_language: "ms", voice_intents: [], closing_state: "active" }],
    agency_settings: [{ agency_id: "agency", voice_language: "ms" }], agencies: [{ id: "agency", name: "Synthetic Agency" }],
    leads: [{ id: "lead", agency_id: "agency", phone: "60123456789", full_name: "Dato' Amin", stage: "lost", pax: 3, do_not_contact: false, package_interest: "Synthetic Umrah" }],
    conversations: [{ id: "conversation", agency_id: "agency", lead_id: "lead", channel: "whatsapp", ai_enabled: true, human_attention_required: false }],
    quotations: [{ id: "quotation", agency_id: "agency", lead_id: "lead", customer_phone: "60123456789", customer_name: "Dato' Amin", quotation_number: "Q-TEST-0007", status: "deposit_paid", total: 29400, quantity: 3, number_of_pilgrims: 3, public_token: "synthetic-document", unit_price: 9800, subtotal: 29400, discount: 0, deposit_rule: "fixed", deposit_amount: 3000, balance_amount: 26400, package_snapshot: { name: "Synthetic Umrah" }, created_at: "2026-09-10" }],
    bookings: [{ id: "booking", agency_id: "agency", lead_id: "lead", status: "deposit_paid", deposit_paid: true, amount_myr: 29400, balance_myr: 26400, pax: 3, quotation_id: "quotation" }],
    whatsapp_configs: [{ agency_id: "agency", phone_number_id: "synthetic-phone", access_token: "synthetic-test-only" }],
    messages: [], ai_tasks: [], activity_log: [], ...overrides,
  };
  const operations: Array<{ table: string; kind: string; values: any; filters: Array<[string, any]> }> = [];
  const failures = new Map<string, { code: string }>();
  const db = { from(table: string) {
    let kind = "select", values: any, limit = Infinity, single = false, orderKey: string | undefined;
    const filters: Array<[string, any]> = [];
    let result: Promise<any> | undefined;
    const execute = () => result ??= Promise.resolve().then(() => {
      operations.push({ table, kind, values, filters });
      const failure = failures.get(`${table}:${kind}`);
      if (failure) return { data: null, error: failure };
      const rows = tables[table] ??= [];
      let matched = rows.filter(row => filters.every(([key, val]) => key.startsWith("ilike:")
        ? String(row[key.slice(6)] ?? "").toLowerCase().includes(String(val).replaceAll("%", "").toLowerCase())
        : row[key] === val));
      if (orderKey) matched = [...matched].sort((a, b) => String(b[orderKey!] ?? "").localeCompare(String(a[orderKey!] ?? "")));
      matched = matched.slice(0, limit);
      if (kind === "insert") {
        if (values.id && rows.some(row => row.id === values.id)) return { data: null, error: { code: "23505" } };
        const row = { id: `${table}-${rows.length + 1}`, ...values };
        rows.push(row); matched = [row];
      } else if (kind === "update") matched.forEach(row => Object.assign(row, values));
      return { data: single ? matched[0] ?? null : matched, error: null };
    });
    const builder: any = {
      select: () => builder, eq: (key: string, value: any) => { filters.push([key, value]); return builder; },
      ilike: (key: string, value: any) => { filters.push([`ilike:${key}`, value]); return builder; },
      order: (key: string) => { orderKey = key; return builder; }, limit: (n: number) => { limit = n; return builder; },
      maybeSingle: () => { single = true; return execute(); }, single: () => { single = true; return execute(); },
      insert: (input: any) => { kind = "insert"; values = input; return builder; },
      update: (input: any) => { kind = "update"; values = input; return builder; },
      then: (resolve: any, reject: any) => execute().then(resolve, reject),
    };
    return builder;
  } };
  return { db, tables, operations, failures };
}
