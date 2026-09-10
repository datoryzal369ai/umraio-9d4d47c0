/* eslint-disable @typescript-eslint/no-explicit-any */
import { bridgeDatabase, binding } from "./calling-bridge-db";
export const businessIds = { lead: "33333333-3333-4333-8333-333333333333", conversation: "44444444-4444-4444-8444-444444444444", quotation: "55555555-5555-4555-8555-555555555555" };
export async function bridgeBusiness() {
  const f = await bridgeDatabase();
  await f.pg.exec(`ALTER TABLE agencies ADD name text DEFAULT 'Synthetic Agency';
    ALTER TABLE whatsapp_call_sessions ADD caller_phone text DEFAULT '60123456789', ADD ended_at timestamptz, ADD voice_intents jsonb, ADD renagi_signals jsonb;
    CREATE TABLE agency_settings(agency_id uuid,voice_persona text,voice_controls jsonb,voice_name text,voice_language text);
    CREATE TABLE leads(id uuid PRIMARY KEY,agency_id uuid,phone text,full_name text,do_not_contact boolean,stage text,preferred_language text,conversational_style text,package_interest text,pax int,updated_at timestamptz);
    CREATE TABLE conversations(id uuid PRIMARY KEY,agency_id uuid,lead_id uuid,channel text,ai_enabled boolean,human_attention_required boolean,last_message_at timestamptz);
    CREATE TABLE quotations(id uuid PRIMARY KEY,agency_id uuid,lead_id uuid,quotation_number text,status text,total numeric,deposit_amount numeric,number_of_pilgrims int,customer_name text,customer_phone text,package_id uuid,travel_month text,updated_at timestamptz,created_at timestamptz DEFAULT now(),public_token text,package_snapshot jsonb);
    CREATE TABLE bookings(id uuid PRIMARY KEY,agency_id uuid,lead_id uuid,status text,deposit_paid boolean,amount_myr numeric,balance_myr numeric,pax int,quotation_id uuid,package_id uuid,updated_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE activity_log(agency_id uuid,actor text,action text,entity text,entity_id text,meta jsonb);
    CREATE TABLE whatsapp_configs(agency_id uuid,phone_number_id text,access_token text);
    ALTER TABLE ai_tasks ADD lead_id uuid, ADD worker_key text, ADD title text, ADD requires_approval boolean, ADD origin text, ADD minutes_saved int, ADD started_at timestamptz, ADD completed_at timestamptz, ADD error text;
    ALTER TABLE messages ADD conversation_id uuid, ADD sender text, ADD body text, ADD modality text, ADD created_at timestamptz DEFAULT now();
    INSERT INTO leads(id,agency_id,phone,full_name,do_not_contact) VALUES('${businessIds.lead}','${binding.agencyId}','60123456789','Dato\u2019 Synthetic',false);
    INSERT INTO conversations VALUES('${businessIds.conversation}','${binding.agencyId}','${businessIds.lead}','whatsapp',true,false,now());
    INSERT INTO quotations(id,agency_id,lead_id,quotation_number,status,total,number_of_pilgrims,customer_name,customer_phone,public_token)
      VALUES('${businessIds.quotation}','${binding.agencyId}','${businessIds.lead}','Q-2026-0007','deposit_paid',29400,3,'Synthetic','60123456789','synthetic-document');
    INSERT INTO whatsapp_configs VALUES('${binding.agencyId}','synthetic-number','synthetic-key');`);
  const id = (v: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(v)) throw new Error("fixture_identifier"); return `"${v}"`; };
  const from = (table: string) => {
    let op = "select", columns = "*", values: any, single = false, signal: AbortSignal | undefined;
    const predicates: Array<[string,string,unknown]> = []; let sort = "", limit = "";
    const execute = async () => {
      signal?.throwIfAborted();
      const params: unknown[] = []; const param = (v: unknown) => { params.push(typeof v === "object" && v !== null && !Array.isArray(v) ? JSON.stringify(v) : v); return `$${params.length}`; };
      const selected = columns === "*" ? "*" : columns.split(",").map(v => id(v.trim())).join(",");
      const data = values ? Object.entries(values) : [];
      let sql = op === "insert" ? `INSERT INTO ${id(table)}(${data.map(([k]) => id(k)).join(",")}) VALUES(${data.map(([,v]) => param(v)).join(",")})`
        : op === "update" ? `UPDATE ${id(table)} SET ${data.map(([k,v]) => `${id(k)}=${param(v)}`).join(",")}` : `SELECT ${selected} FROM ${id(table)}`;
      if (predicates.length) sql += " WHERE " + predicates.map(([k,operator,v]) => operator === "IN" ? `${id(k)}=ANY(${param(v)})` : `${id(k)} ${operator} ${param(v)}`).join(" AND ");
      sql += op === "select" ? sort + limit : " RETURNING " + selected;
      try { const result = await f.pg.query(sql, params); signal?.throwIfAborted(); return { data: single ? result.rows[0] ?? null : result.rows, error: null }; }
      catch (error: any) { return { data: null, error: { code: error.code, message: error.message } }; }
    };
    const q: any = {
      select(v = "*") { columns=v; return q; }, eq(k: string,v: unknown) { predicates.push([k,"=",v]); return q; },
      ilike(k: string,v: unknown) { predicates.push([k,"ILIKE",v]); return q; }, in(k: string,v: unknown) { predicates.push([k,"IN",v]); return q; },
      order(k: string, options?: {ascending?: boolean}) { sort=` ORDER BY ${id(k)} ${options?.ascending === false ? "DESC" : "ASC"}`; return q; },
      limit(n: number) { limit=` LIMIT ${Math.max(0,Math.floor(n))}`; return q; },
      insert(v: unknown) { op="insert"; values=v; return q; }, update(v: unknown) { op="update"; values=v; return q; },
      maybeSingle() { single=true; return q; }, single() { single=true; return q; }, abortSignal(v: AbortSignal) { signal=v; return q; },
      then(resolve: any,reject: any) { return execute().then(resolve,reject); },
    }; return q;
  };
  return { ...f, db: { ...f.db, from } };
}
