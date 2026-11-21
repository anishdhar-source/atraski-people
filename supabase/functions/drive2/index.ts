// Atraski People server, part 2: audited e-signatures (LOI + letters), appraisal letters with salary revisions,
// the daily "what's waiting for you" email, and extra Drive registers (assets, loans, help desk).
// Same callers and secrets as the `drive` function: user JWT, candidate link token, or the cron secret.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class Fail extends Error { constructor(m: string, public status = 400) { super(m); } }
const need = (c: unknown, m: string, s = 400) => { if (!c) throw new Fail(m, s); };
const APP_URL = "https://anishdhar-source.github.io/atraski-people/";
type Doc = Record<string, any>;
type Block = { t: string; text?: string; rows?: [string, string][] };
let REQ: Request | null = null, CFG: Record<string, string> | null = null;

// ---------- data helpers ----------
const isObj = (v: unknown) => v && typeof v === "object" && !Array.isArray(v);
function merge(a: any, b: any): any { if (isObj(a) && isObj(b)) { const o = { ...a }; for (const k of Object.keys(b)) o[k] = merge(a[k], b[k]); return o; } return b; }
async function getDoc(path: string): Promise<Doc | null> { const { data, error } = await admin.from("docs").select("data").eq("path", path).maybeSingle(); if (error) throw error; return data ? data.data : null; }
async function listDocs(c: string) { const { data, error } = await admin.from("docs").select("path,data").eq("collection", c); if (error) throw error; return (data || []) as { path: string; data: Doc }[]; }
async function putDoc(path: string, data: Doc) { const { error } = await admin.from("docs").upsert({ path, collection: path.split("/").slice(0, -1).join("/"), data }, { onConflict: "path" }); if (error) throw error; }
async function patchDoc(path: string, patch: Doc) { const next = merge((await getDoc(path)) || {}, patch); await putDoc(path, next); return next; }
async function cfg() { if (!CFG) { const { data, error } = await admin.rpc("drive_service"); if (error) throw error; CFG = data || {}; } return CFG!; }
async function nextRef(kind: string) { const { data, error } = await admin.rpc("next_ref", { p_kind: kind }); if (error) throw error; return data as string; }
async function members() { const { data, error } = await admin.from("members").select("user_id,name,email,role"); if (error) throw error; return (data || []) as any[]; }
async function roles(): Promise<Record<string, any>> { const r = await getDoc("config/roles"); return (r && r.users) || {}; }
const cleanName = (s: string) => String(s || "").replace(/[\\/:*?"<>|#]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
const esc = (s: string) => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const dmy = (ds: string) => ds ? ds.slice(0, 10).split("-").reverse().join("/") : "";
const inr = (n: number) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const ist = (ms: number) => new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
function safeEq(a: string, b: string) { if (!a || !b || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

// ---------- Drive bridge + email ----------
async function gas(payload: Doc) {
  const c = await cfg(); need(c.drive_url, "Google Drive isn't connected yet. The CEO connects it on the Policy settings page.", 409);
  const r = await fetch(c.drive_url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ ...payload, secret: c.drive_secret }), redirect: "follow" });
  let out: any; try { out = JSON.parse(await r.text()); } catch { throw new Fail(`Drive bridge answered with something unexpected (HTTP ${r.status}).`, 502); }
  if (!out.ok) throw new Fail("Drive: " + (out.error || "failed"), 502); return out;
}
const pdf = (path: string[], name: string, blocks: Block[]) => gas({ action: "letter", path, name, company: "Atraski India · At Buzz", blocks });
async function mail(to: string | undefined, subject: string, paras: string[], attach: string[] = []) {
  if (!to) return null;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#121A2F">${paras.map(p => `<p>${p}</p>`).join("")}<p style="color:#5D667C;font-size:12px">Atraski People · sent automatically</p></div>`;
  try { return await gas({ action: "mail", to, subject, html, text: paras.join("\n\n").replace(/<[^>]+>/g, ""), attach, fromName: "Atraski People" }); } catch (e) { console.error("mail", e); return null; }
}
async function signer() { const m = (await members()).find(x => x.role === "owner"); return { name: (m && m.name) || "Founder", title: "Founder & CEO" }; }

// ---------- signature audit trail ----------
function audit(email?: string) {
  const h = (k: string) => (REQ && REQ.headers.get(k)) || "", ua = h("user-agent");
  const ip = (h("x-forwarded-for").split(",")[0] || h("cf-connecting-ip") || h("x-real-ip")).trim().slice(0, 45);
  const dev = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return { ip, ua: [dev, br].filter(Boolean).join(" ") || ua.slice(0, 40), email: email || "" };
}
function signBlock(name: string, at: number, what: string, a: Doc): Block {
  const t = new Date(at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return { t: "sign", text: `${what} electronically by ${name} on ${t} IST through Atraski People. Audit: ${[a.email && "account " + a.email, a.ip && "IP " + a.ip, a.ua && "device " + a.ua].filter(Boolean).join(" · ")}.` };
}

// ---------- who is calling ----------
async function caller(req: Request) {
  const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""); need(tok, "Sign in first.", 401);
  const { data, error } = await admin.auth.getUser(tok); need(!error && data && data.user, "Your session has ended. Sign in again.", 401);
  const { data: m } = await admin.from("members").select("role,name,email").eq("user_id", data!.user!.id).maybeSingle();
  const role = (m && m.role) || "pending"; need(["owner", "hr", "admin", "member", "finance"].includes(role), "Your account doesn't have access yet.", 403);
  return { uid: data!.user!.id, role, name: (m && m.name) || "", email: (m && m.email) || data!.user!.email || "" };
}
async function personOf(uid: string) {
  const [r, ms, onb] = await Promise.all([roles(), members(), getDoc(`onboard/${uid}`)]); const u = r[uid] || {}, m = ms.find(x => x.user_id === uid) || {}, f = (onb && onb.f) || {};
  return { name: f.fullName || m.name || "Employee", email: f.email || m.email || "", role: u.pos || "Team member", dept: u.dept || "", code: u.code || "", company: u.company || "Atraski India" };
}
async function folderFor(uid: string, name: string) { const h = await getDoc(`hrdocs/${uid}`); return (h && h.drivePath) || ["People", `${cleanName(name)} · ${uid.slice(0, 6)}`]; }

// =====================================================================================
// Candidate confirms the LOI (portal link) — with audit trail
// =====================================================================================
async function opLoi(b: Doc) {
  need(typeof b.cid === "string" && /^[a-f0-9]{12}$/.test(b.cid) && typeof b.token === "string", "This link isn't valid.", 404);
  const path = `cand/${b.cid}`, cd = await getDoc(path); need(cd && safeEq(cd.token, b.token) && !cd.revoked, "This link isn't valid any more. Ask Atraski for a new one.", 404);
  need(cd!.stage === "loi_sent" && cd!.loi, "There's no letter waiting for you.");
  const at = Date.now(), ms = await members(), ceo = ms.find(x => x.role === "owner");
  if (b.decline) {
    await patchDoc(path, { stage: "declined", loi: { declinedAt: at, declineReason: String(b.reason || "").slice(0, 300) }, history: [...(cd!.history || []), { at, what: "Candidate declined the LOI" }] });
    await mail(ceo && ceo.email, `LOI declined: ${cd!.name}`, [`${esc(cd!.name)} declined the Letter of Intent for ${esc(cd!.role)}.`, b.reason ? `Reason: ${esc(b.reason)}` : ""]);
    return { ok: true, stage: "declined" };
  }
  const sign = String(b.signName || "").trim();
  need(sign.length >= 3 && sign.toLowerCase().replace(/\s+/g, " ") === String(cd!.name).toLowerCase().replace(/\s+/g, " "), `Type your full name exactly as "${cd!.name}" to sign.`);
  const aud = audit(cd!.email), s = await signer();
  const out = await pdf([...cd!.drivePath, "Letters"], `LOI ${cd!.loi.ref} - ${cleanName(cd!.name)} - signed`, [...cd!.loi.blocks, signBlock(sign, at, "Intent to join confirmed", aud)]);
  await patchDoc(path, { stage: "loi_accepted", loi: { acceptedAt: at, signName: sign, signedUrl: out.url, signedId: out.id, audit: aud }, history: [...(cd!.history || []), { at, what: `Candidate accepted the LOI (IP ${aud.ip || "?"})` }] });
  await mail(cd!.email, `Your signed Letter of Intent – ${cd!.role}`, [`Dear ${esc(cd!.name.split(" ")[0])},`, "Thank you for confirming. Your signed Letter of Intent is attached.",
    `<b>On your joining day (${dmy(cd!.join)})</b>, create your Atraski People account with this email address (${esc(cd!.email)}) at <a href="${APP_URL}">${APP_URL}</a>. Your appointment letter will be waiting there.`, `${esc(s.name)}<br>${esc(s.title)}, Atraski India`], [out.id]);
  await mail(ceo && ceo.email, `LOI accepted: ${cd!.name}`, [`${esc(cd!.name)} accepted the Letter of Intent for ${esc(cd!.role)}. Joining on ${dmy(cd!.join)}.`, "When they sign up, confirm their joining from <b>Hiring &amp; exits</b>."]);
  return { ok: true, stage: "loi_accepted", acceptedAt: at };
}

// =====================================================================================
// Employee accepts a letter (appointment / internship / traineeship) — with audit trail
// =====================================================================================
async function opLetterAccept(c: Doc, b: Doc) {
  const life = await getDoc(`life/${c.uid}`); need(life && life.letters && life.letters[b.idx], "Letter not found.", 404);
  const lt = life!.letters[b.idx]; need(lt.needsAccept && !lt.acceptedAt, "Nothing to accept.");
  const p = await personOf(c.uid), sign = String(b.signName || "").trim();
  need(sign.toLowerCase().replace(/\s+/g, " ") === p.name.toLowerCase().replace(/\s+/g, " "), `Type your full name exactly as "${p.name}" to sign.`);
  need(b.ackPolicies === true, "Tick the box to confirm you've read the policies.");
  const at = Date.now(), aud = audit(c.email), path = await folderFor(c.uid, p.name);
  const out = await pdf([...path, "Letters"], `${lt.title} ${lt.ref} - ${cleanName(p.name)} - signed`, [...lt.blocks, signBlock(sign, at, "Terms accepted, and Atraski People Policies ATR-HR-01 to ATR-HR-12 acknowledged,", aud)]);
  life!.letters[b.idx] = { ...lt, acceptedAt: at, signName: sign, signedUrl: out.url, signedId: out.id, audit: aud };
  await putDoc(`life/${c.uid}`, life!);
  await patchDoc(`hrdocs/${c.uid}`, { items: { appointment: { url: out.url, status: "verified", at, by: "system", file: `${lt.title} (signed)` },
    nda: { url: out.url, status: "verified", at, by: "system", file: "Confidentiality clause accepted in the signed letter" }, policy: { url: out.url, status: "verified", at, by: "system", file: "Policies acknowledged when signing" } } });
  await mail(p.email, `Signed copy: ${lt.title}`, [`Dear ${esc(p.name.split(" ")[0])},`, "Your signed copy is attached for your records. Welcome aboard!"], [out.id]);
  return { ok: true, url: out.url };
}

// =====================================================================================
// Appraisal letter + salary revision from the effective month (CEO)
// =====================================================================================
async function opAppraisal(c: Doc, b: Doc) {
  need(c.role === "owner", "Only the CEO can issue appraisal letters.", 403);
  const pct = Number(b.pct); need(pct >= 0 && pct <= 100, "Enter an increment between 0 and 100%.");
  need(/^\d{4}-\d{2}-\d{2}$/.test(b.effective || ""), "Pick the effective date.");
  const pay = (await getDoc(`pay/${b.uid}`)) || {}, effYM = b.effective.slice(0, 7);
  const revs = Object.entries(pay.revisions || {}).filter(([k]) => k <= effYM).sort((x, y) => x[0].localeCompare(y[0]));
  const old = revs.length ? Number(revs[revs.length - 1][1]) : Number(pay.salary) || 0; need(old > 0, "Set this person's salary first.");
  const newCtc = Math.round(old * (1 + pct / 100) / 10) * 10, basic = Math.round(newCtc * .5), hra = Math.round(newCtc * .2);
  await patchDoc(`pay/${b.uid}`, { revisions: { [effYM]: newCtc }, ...(effYM <= todayIST().slice(0, 7) ? { salary: newCtc } : {}) });
  const p = await personOf(b.uid), s = await signer(), ref = await nextRef("APR"), date = todayIST();
  const blocks: Block[] = [
    { t: "p", text: `Date: ${dmy(date)}\nRef No: ${ref}` }, { t: "p", text: `To,\n${p.name} (${p.code || "—"})` }, { t: "title", text: "APPRAISAL LETTER" }, { t: "p", text: `Dear ${p.name.split(" ")[0]},` },
    { t: "p", text: `Following your performance review${b.cycle ? " (" + b.cycle + ")" : ""}${Number(b.rating) ? `, with an overall rating of ${b.rating} out of 5` : ""}, we are pleased to revise your compensation as ${p.role}${p.dept ? " in " + p.dept : ""}.` },
    { t: "kv", rows: [["Current monthly gross", inr(old)], ["Increment", `${pct}%`], ["Revised monthly gross", inr(newCtc)], ["Effective from", dmy(b.effective)]] },
    { t: "h", text: "Revised salary (monthly)" }, { t: "kv", rows: [["Basic", inr(basic)], ["HRA", inr(hra)], ["Special allowance", inr(newCtc - basic - hra)], ["Gross", inr(newCtc)]] },
    { t: "p", text: "All other terms of your appointment remain unchanged. Thank you for your contribution; we look forward to another strong year together." },
    { t: "note", text: "This letter is confidential." }, { t: "p", text: "Yours sincerely," }, { t: "p", text: `${s.name}\n${s.title} | Atraski India` }];
  const out = await pdf([...(await folderFor(b.uid, p.name)), "Letters"], `Appraisal Letter ${ref} - ${cleanName(p.name)}`, blocks);
  const life = (await getDoc(`life/${b.uid}`)) || {};
  await putDoc(`life/${b.uid}`, { ...life, letters: [...(life.letters || []), { kind: "APR", title: "Appraisal Letter", ref, blocks, url: out.url, id: out.id, issuedAt: Date.now(), needsAccept: false }] });
  await mail(p.email, `Your appraisal letter – ${p.company}`, [`Dear ${esc(p.name.split(" ")[0])},`, `Your appraisal letter is attached: your revised monthly gross is <b>${inr(newCtc)}</b> from ${dmy(b.effective)}.`, `${esc(s.name)}<br>${esc(s.title)}, Atraski India`], [out.id]);
  return { ok: true, newCtc, effective: b.effective, ref };
}

// =====================================================================================
// Daily digest: one email per person listing what's waiting for them
// =====================================================================================
async function digest() {
  const auto = (await getDoc("config/automation")) || {}; if (auto.digest === false) return { ok: true, skipped: true };
  const [ms, r] = await Promise.all([members(), roles()]);
  const cols = ["att", "decisions", "finance", "tickets", "loanreq", "cand", "exit", "life", "assetmine", "assetack", "fbreq", "paycheck"];
  const got = Object.fromEntries(await Promise.all(cols.map(async c => [c, await listDocs(c)])));
  const top = (c: string) => Object.fromEntries((got[c] as any[]).filter(x => x.path.split("/").length === 2).map(x => [x.path.split("/")[1], x.data]));
  const A = top("att"), D = top("decisions"), F = top("finance"), T = top("tickets"), LR = top("loanreq"), X = top("exit"), LF = top("life"), AM = top("assetmine"), AK = top("assetack"), FB = top("fbreq");
  const owner = ms.find(m => m.role === "owner"), ceo = owner && owner.user_id, fins = ms.filter(m => m.role === "finance").map(m => m.user_id);
  const box: Record<string, string[]> = {}, add = (u: string | undefined, line: string) => { if (u) (box[u] = box[u] || []).push(line); };
  const nm = (id: string) => (ms.find(m => m.user_id === id) || {} as any).name || (A[id] && A[id].title) || "Someone";
  const approver = (id: string) => { const m = (r[id] || {}).manager; return m && ms.some(x => x.user_id === m && x.role !== "pending") ? m : ceo; };
  for (const [id, root] of Object.entries(A) as [string, Doc][]) {
    let leave = 0, pre = 0, claims = 0, fin = 0;
    for (const [rid, q] of Object.entries((root.requests || {}) as Record<string, any>)) if (!q.withdrawn && !(((D[id] || {})[rid] || {}).s)) leave++;
    for (const t of Object.values((root.trips || {}) as Record<string, any>)) { if (t.withdrawn) continue; const d = { ...((D[id] || {})["t_" + t.tid] || {}), ...((F[id] || {})["t_" + t.tid] || {}) };
      if (!(d.pre && d.pre.s)) pre++; else if (d.pre.s === "approved" && t.claim && t.claim.at && !(d.mgr && d.mgr.s)) claims++;
      else if (d.mgr && d.mgr.s === "approved" && !(d.fin && (["approved", "rejected"].includes(d.fin.s) || (d.fin.s === "query" && !(t.claim.at > d.fin.at))))) fin++; }
    const ap = approver(id);
    if (leave) add(ap, `${nm(id)}: ${leave} leave / WFH request${leave > 1 ? "s" : ""} to approve`);
    if (pre) add(ap, `${nm(id)}: ${pre} trip${pre > 1 ? "s" : ""} waiting for pre-approval`);
    if (claims) add(ap, `${nm(id)}: ${claims} expense claim${claims > 1 ? "s" : ""} to approve`);
    if (fin) fins.forEach(f => add(f, `${nm(id)}: ${fin} claim${fin > 1 ? "s" : ""} to verify for payment`));
  }
  for (const { data: pc } of got.paycheck as any[]) if (pc && pc.sentAt && !(pc.fin && pc.fin.s === "approved")) fins.forEach(f => add(f, `Pay run ${pc.ym || ""} is waiting for your check`));
  for (const [id, d] of Object.entries(T) as [string, Doc][]) for (const t of Object.values((d.items || {}) as Record<string, any>)) { if (t.status === "open" && id !== ceo) add(ceo, `Help desk: "${t.subject}" from ${nm(id)}`); if (t.status === "answered") add(id, `Your help desk ticket "${t.subject}" has an answer`); }
  for (const [id, d] of Object.entries(LR) as [string, Doc][]) for (const q of Object.values((d.items || {}) as Record<string, any>)) if (q.status === "requested") add(ceo, `${nm(id)} asked for a ${q.kind === "advance" ? "salary advance" : "loan"} of ${inr(q.amount)}`);
  for (const { data: c } of got.cand as any[]) { if (c.stage === "submitted") add(ceo, `Candidate ${c.name} sent their documents: issue the LOI`); if (c.stage === "loi_accepted" && ms.some(m => String(m.email || "").toLowerCase() === String(c.email).toLowerCase())) add(ceo, `${c.name} has signed up: confirm their joining`); }
  for (const m of ms.filter(m => m.role === "pending" && !(r[m.user_id] && r[m.user_id].exited))) add(ceo, `${m.name || m.email} signed up and is waiting for access`);
  for (const [id, x] of Object.entries(X) as [string, Doc][]) {
    if (x.stage === "nodues") add(ceo, `Approve ${nm(id)}'s F&F statement`); if (x.stage === "fnf") add(ceo, `Pay ${nm(id)}'s F&F (due ${dmy(x.fnf.due)})`);
    if (x.stage === "notice") { const hv = x.handover || {}, mg = (r[id] || {}).manager;
      if (!x.handoverNote) add(id, `Submit your handover before ${dmy(x.lwd)}`); else { if (mg && !(hv.h1 && hv.h1.ok)) add(mg, `Sign off ${nm(id)}'s handover`); if (!(hv.h3 && hv.h3.ok) || !(hv.h4 && hv.h4.ok)) add(ceo, `Sign off files and assets for ${nm(id)}'s exit`); }
      if (!(hv.h5 && hv.h5.ok)) fins.forEach(f => add(f, `List advances and recoveries for ${nm(id)}'s exit`)); }
  }
  for (const [id, l] of Object.entries(LF) as [string, Doc][]) for (const t of (l.letters || [])) if (t.needsAccept && !t.acceptedAt) add(id, `Read and accept your ${String(t.title).toLowerCase()}`);
  for (const [id, a] of Object.entries(AM) as [string, Doc][]) for (const [aid, x] of Object.entries((a.items || {}) as Record<string, any>)) if (!(AK[id] || {})[aid]) add(id, `Acknowledge the ${String(x.type).toLowerCase()} assigned to you`);
  for (const [id, f] of Object.entries(FB) as [string, Doc][]) for (const [rid, q] of Object.entries((f.items || {}) as Record<string, any>)) { const ans = await getDoc(`fbans/${q.subject}/r/${id}`); if (!(ans && ans[rid])) add(id, `Give anonymous feedback about ${nm(q.subject)} by ${dmy(q.due)}`); }
  let sent = 0;
  for (const m of ms.filter(m => m.role !== "pending")) { const lines = box[m.user_id]; if (!lines || !lines.length || !m.email) continue;
    if (await mail(m.email, `Atraski People: ${lines.length} thing${lines.length > 1 ? "s" : ""} waiting for you`, [`Good morning ${esc(String(m.name || "").split(" ")[0])},`, `<ul>${lines.slice(0, 25).map(x => `<li>${esc(x)}</li>`).join("")}</ul>`,
      `<a href="${APP_URL}" style="display:inline-block;background:#0F1730;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open Atraski People</a>`])) sent++; }
  return { ok: true, sent, people: Object.keys(box).length, lines: Object.values(box).reduce((a, x) => a + x.length, 0) };
}

// =====================================================================================
// Extra Drive registers: assets, loans & advances, help desk (run with the nightly backup)
// =====================================================================================
async function registers() {
  const [ms, areg, loans, tks, att] = await Promise.all([members(), getDoc("assetreg/main"), listDocs("loans"), listDocs("tickets"), listDocs("att")]);
  const titles = Object.fromEntries(att.filter(x => x.path.split("/").length === 2).map(x => [x.path.split("/")[1], x.data.title]));
  const nm = (id: string) => (ms.find(m => m.user_id === id) || {} as any).name || titles[id] || id.slice(0, 6), uid = (p: string) => p.split("/")[1], yr = todayIST().slice(0, 4);
  const items = [
    { action: "sheet", path: ["Assets"], name: "Asset register", tabs: [{ name: "Assets", rows: [["Type", "Asset", "Serial", "Value", "With", "Since", "Condition", "History"],
      ...Object.values(((areg || {}).items || {}) as Record<string, any>).map((x: any) => [x.type, x.name, x.serial || "", x.value || "", x.holder ? nm(x.holder) : "In stock", x.since || "", x.cond || "", (x.history || []).map((h: any) => h.what).join(" | ")])] }] },
    { action: "sheet", path: ["Loans & advances"], name: "Loans register", tabs: [{ name: "Loans", rows: [["Employee", "Kind", "Amount", "EMI", "Months", "From", "Repaid", "Balance", "Purpose"],
      ...loans.filter(x => x.path.split("/").length === 2).flatMap(({ path, data }) => Object.values((data.items || {}) as Record<string, any>).map((l: any) => { const paid = Object.values(l.paid || {}).reduce((a: number, v: any) => a + (Number(v) || 0), 0); return [nm(uid(path)), l.kind, l.amount, l.emi, l.months, l.startYM, paid, Math.max(0, l.amount - paid), l.purpose || l.label || ""]; }))] }] },
    { action: "sheet", path: ["Help desk"], name: `Tickets ${yr}`, tabs: [{ name: "Tickets", rows: [["Employee", "Topic", "Subject", "Status", "Raised", "Messages", "Last message"],
      ...tks.filter(x => x.path.split("/").length === 2).flatMap(({ path, data }) => Object.values((data.items || {}) as Record<string, any>).map((t: any) => [nm(uid(path)), t.cat, t.subject, t.status, ist(t.at), (t.thread || []).length, ((t.thread || []).slice(-1)[0] || {}).text || ""]))] }] },
  ];
  const out = await gas({ action: "batch", items }); const errs = (out.results || []).filter((x: any) => !x.ok).map((x: any) => x.error);
  return { ok: !errs.length, files: (out.results || []).length, errors: errs };
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  CFG = null; REQ = req;
  try {
    const b = await req.json().catch(() => ({})), cron = req.headers.get("x-cron");
    if (cron) { need(safeEq(cron, (await cfg()).cron_secret || ""), "Forbidden", 403); if (b.op === "digest") return json(await digest()); if (b.op === "registers") return json(await registers()); throw new Fail("Unknown"); }
    if (b.op === "portal_loi") return json(await opLoi(b));
    const c = await caller(req);
    switch (b.op) {
      case "letter_accept": return json(await opLetterAccept(c, b));
      case "appraisal": return json(await opAppraisal(c, b));
      case "digest": need(c.role === "owner", "Only the CEO.", 403); return json(await digest());
      case "registers": need(c.role === "owner", "Only the CEO.", 403); return json(await registers());
      default: throw new Fail("Unknown request.");
    }
  } catch (e) {
    const st = e instanceof Fail ? e.status : 500; if (!(e instanceof Fail)) console.error(e);
    return json({ ok: false, error: e instanceof Fail ? e.message : "Something went wrong on the server: " + String((e as Error)?.message || e).slice(0, 200) }, st);
  }
});
