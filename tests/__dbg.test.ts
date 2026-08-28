import { describe, it } from "vitest";
import { ensureBookingForAcceptedQuotation } from "@/lib/bookings/booking.server";
describe("d", () => { it("x", async () => {
  const tables: any = { quotations: [{id:"q1",agency_id:"A",status:"accepted",deposit_amount:1500,total:1,lead_id:"l"}], bookings: [], conversion_events: [] };
  const db: any = { from: (t: string) => {
    const f: any[] = []; let op="select"; let payload: any=null;
    const api: any = { select:()=>api, eq:(c:string,v:any)=>{f.push((r:any)=>r[c]===v);return api;}, neq:()=>api, in:()=>api, order:()=>api,
      limit:()=>run(), maybeSingle:()=>run().then((r:any)=>({data:r.data?.[0]??null,error:null})), single:()=>api.maybeSingle(),
      insert:(d:any)=>{op="insert";payload=d;return api;}, update:(d:any)=>{op="update";payload=d;return api;}, then:(a:any,b:any)=>run().then(a,b) };
    function run(){ console.log("RUN",t,op); if(op==="insert"){const row={id:t+"-1",...payload};tables[t].push(row);return Promise.resolve({data:[row],error:null});}
      if(op==="update"){const rows=tables[t].filter((r:any)=>f.every((fn)=>fn(r)));rows.forEach((r:any)=>Object.assign(r,payload));return Promise.resolve({data:rows,error:null});}
      return Promise.resolve({data:tables[t].filter((r:any)=>f.every((fn)=>fn(r))),error:null}); }
    return api; } };
  console.log(await ensureBookingForAcceptedQuotation(db, {agencyId:"A",quotationId:"q1"}), tables.bookings);
});});
