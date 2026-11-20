// Letter content for Atraski People. Pure functions (no network) so they can be tested on their own.
// Wording follows the Atraski templates in HR Master (LOI, Appointment, Exit/Relieving) and ATR-HR-01/02/10 v3.0.

export type Block = { t: "title" | "h" | "p" | "kv" | "sign" | "note"; text?: string; rows?: [string, string][] };
export type Letter = { kind: string; title: string; blocks: Block[] };

export const KIND_NAME: Record<string, string> = {
  LOI: "Letter of Intent", APT: "Appointment Letter", INT: "Internship Letter", TRN: "Traineeship Letter",
  CNF: "Confirmation Letter", EXT: "Probation Extension Letter", RES: "Resignation Acknowledgement",
  NDC: "No Dues Certificate", FNF: "Full & Final Settlement Statement", RL: "Relieving Letter", EXP: "Experience Certificate",
};
const ETYPE: Record<string, string> = { employee: "Full-time employee (probationer)", trainee: "Trainee", intern: "Intern" };

export const inr = (n: number) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
export const dmy = (ds: string) => { if (!ds) return ""; const [y, m, d] = ds.slice(0, 10).split("-"); return `${d}/${m}/${y}`; };
export const longDate = (ds: string) => { if (!ds) return ""; const d = new Date(ds.slice(0, 10) + "T00:00:00Z"); return d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); };
export function addDays(ds: string, n: number) { const d = new Date(ds.slice(0, 10) + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function addMonths(ds: string, n: number) { const d = new Date(ds.slice(0, 10) + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
export function monthsBetween(a: string, b: string) { const A = new Date(a + "T00:00:00Z"), B = new Date(b + "T00:00:00Z"); return (B.getUTCFullYear() - A.getUTCFullYear()) * 12 + (B.getUTCMonth() - A.getUTCMonth()) - (B.getUTCDate() < A.getUTCDate() ? 1 : 0); }
export function todayIST() { return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); }

// Salary split used on letters unless the CEO set one: Basic 50%, HRA 20%, Special allowance the rest.
export function split(gross: number, b?: { basic?: number; hra?: number }) {
  const g = Math.round(Number(gross) || 0);
  const basic = Math.round(b && b.basic ? b.basic : g * 0.5), hra = Math.round(b && b.hra ? b.hra : g * 0.2);
  return { gross: g, basic, hra, special: Math.max(0, g - basic - hra) };
}

// Notice period under ATR-HR-10 §2 (an explicit override on the person wins).
export function noticeDays(p: { join?: string; etype?: string; probEnd?: string; confirmed?: string; notice?: number }, onDate: string) {
  if (p.notice) return Number(p.notice);
  if (p.join && onDate < addDays(p.join, 14)) return 1;
  if (p.etype === "intern" || p.etype === "trainee") return 15;
  const probEnd = p.probEnd || (p.join ? addMonths(p.join, 6) : "");
  if (!p.confirmed && probEnd && onDate < probEnd) return 15;
  return 30;
}

export type Person = { name: string; email?: string; phone?: string; address?: string; role: string; dept?: string; company?: string;
  etype?: string; tenure?: number; location?: string; workMode?: string; manager?: string; managerRole?: string; join?: string; code?: string;
  ctc?: number; basic?: number; hra?: number; cycle?: string };
export type Signer = { name: string; title: string; email?: string };

const signOff = (s: Signer): Block[] => [{ t: "p", text: "Yours sincerely," }, { t: "p", text: `${s.name}\n${s.title} | Atraski India${s.email ? "\n" + s.email : ""}` }];

export function letterLOI(p: Person, s: Signer, o: { ref: string; date: string; acceptBy: string; docsDays?: number }): Letter {
  return { kind: "LOI", title: KIND_NAME.LOI, blocks: [
    { t: "p", text: `Date: ${dmy(o.date)}\nRef No: ${o.ref}` },
    { t: "p", text: `To,\n${p.name}\n${[p.email, p.phone].filter(Boolean).join("\n")}` },
    { t: "title", text: "LETTER OF INTENT (LOI)" },
    { t: "p", text: `Subject: Letter of Intent – ${p.role}${p.dept ? " | " + p.dept : ""}` },
    { t: "p", text: `Dear ${p.name.split(" ")[0]},` },
    { t: "p", text: `Following our interview and evaluation process, we are pleased to express our intent to offer you the role of ${p.role} at ${p.company || "Atraski India"}.` },
    { t: "p", text: "This Letter of Intent (LOI) confirms our plan to issue your appointment on joining, subject to the conditions below." },
    { t: "h", text: "Proposed terms (subject to joining)" },
    { t: "kv", rows: [["Role", p.role], ["Department", p.dept || "—"], ["Category", ETYPE[p.etype || "employee"] || "—"], ["Expected CTC", `${inr(p.ctc || 0)} per month`],
      ["Expected joining", `On or before ${dmy(p.join || "")}`], ["Work mode", p.workMode || "Work from office"], ["Location", p.location || "—"]] },
    { t: "h", text: "Conditions precedent" },
    { t: "p", text: `1. Successful completion of background and reference checks.\n2. Submission of all requested documents within ${o.docsDays || 3} business days.\n3. Final management approval.` },
    { t: "h", text: "Next steps" },
    { t: "p", text: `Please confirm your intent to join on or before ${dmy(o.acceptBy)} using your Atraski People link. Your appointment letter is issued on your date of joining, after the 14-day Training & Assessment Phase begins (ATR-HR-01).` },
    { t: "note", text: "This LOI does not constitute a legally binding employment contract." },
    { t: "p", text: "We look forward to you joining the Atraski team." },
    ...signOff(s),
  ] };
}

export function letterAppointment(p: Person, s: Signer, o: { ref: string; date: string }): Letter {
  const kind = p.etype === "intern" ? "INT" : p.etype === "trainee" ? "TRN" : "APT";
  const sal = split(p.ctc || 0, { basic: p.basic, hra: p.hra });
  const len = p.etype === "intern" ? `${p.tenure === 6 ? 6 : 3} months from the date of joining (extendable once, up to 6 months)` : p.etype === "trainee" ? "2–3 months from the date of joining" : "6 months from the date of joining (ATR-HR-01). Confirmation is subject to a satisfactory review; probation can be extended once, by up to 3 months.";
  return { kind, title: KIND_NAME[kind], blocks: [
    { t: "p", text: `Date: ${dmy(o.date)}\nRef No: ${o.ref}` },
    { t: "p", text: `To,\n${p.name}${p.address ? "\n" + p.address : ""}` },
    { t: "title", text: KIND_NAME[kind].toUpperCase() },
    { t: "p", text: `Subject: ${kind === "APT" ? "Appointment" : kind === "INT" ? "Internship" : "Traineeship"} as ${p.role} – ${p.company || "Atraski India"}` },
    { t: "p", text: `Dear ${p.name.split(" ")[0]},` },
    { t: "p", text: `With reference to your application, interviews and discussions, we are pleased to ${kind === "APT" ? "appoint you" : "engage you"} as ${p.role}${p.dept ? " in " + p.dept : ""} at ${p.company || "Atraski India"} on the following terms and conditions:` },
    { t: "kv", rows: [["Date of joining", dmy(p.join || "")], ["Employee code", p.code || "—"], ["Designation", p.role], ["Department", p.dept || "—"],
      ["Reporting manager", p.manager ? `${p.manager}${p.managerRole ? ", " + p.managerRole : ""}` : "—"], ["Place of posting", p.location || "—"], ["Employment type", ETYPE[p.etype || "employee"]]] },
    { t: "h", text: "Compensation (monthly)" },
    { t: "kv", rows: [["Gross", inr(sal.gross)], ["Basic", inr(sal.basic)], ["HRA", inr(sal.hra)], ["Special allowance", inr(sal.special)],
      ["Salary disbursement", `By the ${p.cycle === "15" ? "15th" : "10th"} of every month, subject to applicable TDS`]] },
    { t: "h", text: "Working hours (ATR-HR-02)" },
    { t: "p", text: "Punch in by 11:00 AM and work 8 hours a day; earliest punch-out is your punch-in + 8 hours. Weekly off and holidays follow the company calendar." },
    { t: "h", text: kind === "APT" ? "Probation" : "Duration" },
    { t: "p", text: `${len} The first 14 days are an in-person Training & Assessment Phase with no leave, short leave or WFH.` },
    { t: "h", text: "Notice period (ATR-HR-10)" },
    { t: "p", text: "First 14 days: 1 day. Interns, trainees and probationers: 15 days. Confirmed staff: 30 days (leadership 60–90 days as per contract). Written notice by either party; paid leave is not taken during notice." },
    { t: "h", text: "Leave and policies" },
    { t: "p", text: "Leave, WFH, attendance, expenses, conduct, confidentiality and exit follow the Atraski People Policies ATR-HR-01 to ATR-HR-12 (v3.0), available in Atraski People." },
    { t: "h", text: "Confidentiality and conduct" },
    { t: "p", text: "You will keep all company, client and operational information confidential during and after your employment (ATR-HR-06), and follow the Code of Conduct (ATR-HR-11). The company may end this appointment without notice for proven misconduct, fraud or material breach of these terms." },
    { t: "p", text: "Please accept this letter in Atraski People to confirm the terms. We look forward to a long and rewarding association with you." },
    ...signOff(s),
  ] };
}

export function letterConfirmation(p: Person, s: Signer, o: { ref: string; date: string; from: string }): Letter {
  return { kind: "CNF", title: KIND_NAME.CNF, blocks: [
    { t: "p", text: `Date: ${dmy(o.date)}\nRef No: ${o.ref}` }, { t: "p", text: `To,\n${p.name} (${p.code || "—"})` },
    { t: "title", text: "CONFIRMATION OF EMPLOYMENT" },
    { t: "p", text: `Dear ${p.name.split(" ")[0]},` },
    { t: "p", text: `Further to the review of your performance during probation, we are pleased to confirm your employment as ${p.role}${p.dept ? " in " + p.dept : ""} with effect from ${dmy(o.from)}.` },
    { t: "p", text: "As a confirmed employee you are entitled to 12 days of casual/sick leave a year, earned leave after 12 months of service, WFH that can be combined quarterly or half-yearly, and a notice period of 30 days. All other terms of your appointment letter remain unchanged." },
    { t: "p", text: "Congratulations, and thank you for your contribution so far." }, ...signOff(s),
  ] };
}
export function letterExtension(p: Person, s: Signer, o: { ref: string; date: string; until: string; reason: string }): Letter {
  return { kind: "EXT", title: KIND_NAME.EXT, blocks: [
    { t: "p", text: `Date: ${dmy(o.date)}\nRef No: ${o.ref}` }, { t: "p", text: `To,\n${p.name} (${p.code || "—"})` },
    { t: "title", text: "EXTENSION OF PROBATION" },
    { t: "p", text: `Dear ${p.name.split(" ")[0]},` },
    { t: "p", text: `Following your probation review, your probation as ${p.role} is extended until ${dmy(o.until)} (ATR-HR-01 §4).` },
    { t: "h", text: "Reasons and goals" }, { t: "p", text: o.reason || "—" },
    { t: "p", text: "Your manager will review your progress before the new end date. All other terms of your appointment letter remain unchanged." }, ...signOff(s),
  ] };
}
export function letterResignationAck(p: Person, s: Signer, o: { date: string; resigned: string; notice: number; lwd: string }): Letter {
  return { kind: "RES", title: KIND_NAME.RES, blocks: [
    { t: "p", text: `Date: ${dmy(o.date)}` }, { t: "p", text: `To,\n${p.name} (${p.code || "—"})` },
    { t: "title", text: "RESIGNATION ACKNOWLEDGEMENT" },
    { t: "p", text: `Dear ${p.name.split(" ")[0]},` },
    { t: "p", text: `We acknowledge your resignation submitted on ${dmy(o.resigned)}. Under ATR-HR-10 your notice period is ${o.notice} day${o.notice === 1 ? "" : "s"}, so your last working day is ${dmy(o.lwd)}.` },
    { t: "p", text: "Please serve the full notice working normally, and submit your handover in Atraski People at least 5 working days before your last working day. Paid leave is not taken during notice. Your full-and-final settlement is paid within 45–60 days of your last working day, after the No Dues Certificate is issued." },
    ...signOff(s),
  ] };
}
export function letterNoDues(p: Person, s: Signer, o: { ref: string; date: string; lwd: string; signoffs: [string, string][] }): Letter {
  return { kind: "NDC", title: KIND_NAME.NDC, blocks: [
    { t: "p", text: `Date: ${dmy(o.date)}\nRef No: ${o.ref}` }, { t: "title", text: "NO DUES CERTIFICATE" },
    { t: "kv", rows: [["Employee", `${p.name} (${p.code || "—"})`], ["Designation", p.role], ["Department", p.dept || "—"], ["Last working day", dmy(o.lwd)]] },
    { t: "h", text: "Handover sign-offs (ATR-HR-10 §4)" }, { t: "kv", rows: o.signoffs },
    { t: "p", text: "All handover items have been signed off. The employee has no outstanding dues other than those listed in the full-and-final settlement statement." }, ...signOff(s),
  ] };
}
export type FnfLine = [string, number];
export function letterFnf(p: Person, s: Signer, o: { ref: string; date: string; lwd: string; earn: FnfLine[]; less: FnfLine[]; due: string; notes?: string }): Letter {
  const tot = (l: FnfLine[]) => l.reduce((a, x) => a + (Number(x[1]) || 0), 0), net = tot(o.earn) - tot(o.less);
  return { kind: "FNF", title: KIND_NAME.FNF, blocks: [
    { t: "p", text: `Date: ${dmy(o.date)}\nRef No: ${o.ref}` }, { t: "title", text: "FULL & FINAL SETTLEMENT STATEMENT" },
    { t: "kv", rows: [["Employee", `${p.name} (${p.code || "—"})`], ["Designation", p.role], ["Date of joining", dmy(p.join || "")], ["Last working day", dmy(o.lwd)]] },
    { t: "h", text: "Earnings" }, { t: "kv", rows: [...o.earn.map(([k, v]) => [k, inr(v)] as [string, string]), ["Total earnings", inr(tot(o.earn))]] },
    { t: "h", text: "Less: recoveries" }, { t: "kv", rows: [...(o.less.length ? o.less.map(([k, v]) => [k, inr(v)] as [string, string]) : [["None", inr(0)] as [string, string]]), ["Total recoveries", inr(tot(o.less))]] },
    { t: "kv", rows: [[net >= 0 ? "Net payable to employee" : "Net recoverable from employee", inr(Math.abs(net))], ["Payment due by", dmy(o.due)]] },
    ...(o.notes ? [{ t: "note", text: o.notes } as Block] : []),
    { t: "note", text: "Computed under ATR-HR-10 §5–6: salary for days worked to the last working day, EL encashment at the basic rate for confirmed employees, approved claims, less notice shortfall (unserved days × gross ÷ 30), advances and unreturned assets." },
    ...signOff(s),
  ] };
}
export function letterRelieving(p: Person, s: Signer, o: { ref: string; date: string; lwd: string }): Letter {
  return { kind: "RL", title: KIND_NAME.RL, blocks: [
    { t: "p", text: `Date: ${dmy(o.date)}\nRef No: ${o.ref}` }, { t: "p", text: "To Whom It May Concern," },
    { t: "title", text: "RELIEVING LETTER" },
    { t: "p", text: `Subject: Relieving Letter – ${p.name} | ${p.role}` },
    { t: "p", text: `This is to certify that ${p.name} (Employee Code: ${p.code || "—"}) was employed with ${p.company || "Atraski India"} as ${p.role}${p.dept ? " in " + p.dept : ""} from ${dmy(p.join || "")} to ${dmy(o.lwd)}.` },
    { t: "p", text: `${p.name.split(" ")[0]} has been relieved from their duties effective ${dmy(o.lwd)}, following the completion of their notice period and handover, and has no dues pending with the company.` },
    { t: "p", text: "We wish them the very best in all future endeavours." },
    { t: "note", text: "Confidentiality and IP obligations continue after employment, and the 12-month non-solicitation in ATR-HR-06 applies." },
    ...signOff(s),
  ] };
}
export function letterExperience(p: Person, s: Signer, o: { ref: string; date: string; lwd: string }): Letter {
  return { kind: "EXP", title: KIND_NAME.EXP, blocks: [
    { t: "p", text: `Date: ${dmy(o.date)}\nRef No: ${o.ref}` }, { t: "title", text: "EXPERIENCE CERTIFICATE" },
    { t: "p", text: "To Whom It May Concern," },
    { t: "p", text: `This is to certify that ${p.name} worked with ${p.company || "Atraski India"} as ${p.role}${p.dept ? " in " + p.dept : ""} from ${dmy(p.join || "")} to ${dmy(o.lwd)}.` },
    { t: "p", text: `During their tenure, ${p.name.split(" ")[0]} was a committed member of the team, and we appreciate their contribution to Atraski.` },
    { t: "p", text: "This certificate is issued on request for employment verification." }, ...signOff(s),
  ] };
}
export function signBlock(name: string, atMs: number, what = "Accepted"): Block {
  const t = new Date(atMs).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return { t: "sign", text: `${what} electronically by ${name} on ${t} IST through Atraski People.` };
}
