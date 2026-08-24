import { describe, expect, it } from "vitest";
import { detectHumanRequest } from "@/lib/sales/hardening.core";
const c1=["Kenapa cakap macam robot?","Cakap macam orang.","Suara macam robot.","Boleh cakap lebih natural?","Jangan bunyi macam robot.","Cakap Melayu macam orang biasa.","Boleh ubah cara bercakap?","Suara tu terlalu formal."];
const c2=["Saya nak cakap dengan staff.","Boleh sambungkan saya dengan manusia?","Saya nak bercakap dengan orang.","Transfer saya kepada staff.","Saya mahu human agent.","Boleh bagi saya customer service?","Saya nak bercakap dengan pegawai.","Tolong sambungkan dengan manusia."];
const c3=["Cakap macam robot, saya nak staff.","Suara macam robot. Boleh sambungkan saya dengan manusia?","Saya tak suka cara awak jawab, bagi saya staff."];
const c4=["Saya nak orang yang boleh bantu.","Saya perlukan bantuan orang.","Boleh saya bercakap dengan seseorang?"];
describe("cat",()=>{it("dump",()=>{for(const g of [c1,c2,c3,c4]){console.log(g.map(s=>`${detectHumanRequest(s)?"HANDOVER":"no       "} | ${s}`).join("\n"));console.log("---")}})});
