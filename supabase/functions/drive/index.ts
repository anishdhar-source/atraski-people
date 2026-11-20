// Atraski People server: Google Drive bridge + the hire-to-exit lifecycle, with no HR person in the loop.
// Callers: the app (user JWT), the candidate portal (candidate id + token), and the nightly cron (x-cron secret).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import * as L from "./letters.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!, SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class Fail extends Error { constructor(msg: string, public status = 400) { super(msg); } }
const need = (c: unknown, msg: string, status = 400) => { if (!c) throw new Fail(msg, status); };

// ---------- documents table helpers ----------
type Doc = Record<string, any>;
async function getDoc(path: string): Promise<Doc | null> { const { data, error } = await admin.from("docs").select("data").eq("path", path).maybeSingle(); if (error) throw error; return data ? data.data : null; }
async function listDocs(collection: string): Promise<{ path: string; data: Doc }[]> { const { data, error } = await admin.from("docs").select("path,data").eq("collection", collection); if (error) throw error; return data || []; }
const isObj = (v: unknown) => v && typeof v === "object" && !Array.isArray(v);
function merge(a: any, b: any): any { if (isObj(a) && isObj(b)) { const o = { ...a }; for (const k of Object.keys(b)) o[k] = b[k] === undefined ? a[k] : merge(a[k], b[k]); return o; } return b; }
async function putDoc(path: string, data: Doc) { const { error } = await admin.from("docs").upsert({ path, collection: path.split("/")[0], data }, { onConflict: "path" }); if (error) throw error; }
async function patchDoc(path: string, patch: Doc) { const cur = (await getDoc(path)) || {}; const next = merge(cur, patch); await putDoc(path, next); return next; }

// ---------- settings, people ----------
let CFG: Record<string, string> | null = null;
async function cfg() { if (!CFG) { const { data, error } = await admin.rpc("drive_service"); if (error) throw error; CFG = data || {}; } return CFG!; }
async function nextRef(kind: string) { const { data, error } = await admin.rpc("next_ref", { p_kind: kind }); if (error) throw error; return data as string; }
async function members() { const { data, error } = await admin.from("members").select("user_id,name,email,role,created_at"); if (error) throw error; return data || []; }
async function signer(): Promise<L.Signer> { const m = (await members()).find(x => x.role === "owner"); return { name: (m && m.name) || "Founder", title: "Founder & CEO", email: "hr@atraski.com" }; }
async function roles(): Promise<Record<string, any>> { const r = await getDoc("config/roles"); return (r && r.users) || {}; }
async function policy(): Promise<Doc> { return (await getDoc("config/policy")) || {}; }
const officeName = (pol: Doc, id?: string) => { const o = (pol.offices || []).find((x: any) => x.id === id); return o ? String(o.n).split(" · ")[0] : (id === "client" ? "Client site" : id || ""); };
const randHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, "0")).join("");
const nowMs = () => Date.now();
const ist = (ms: number, withTime = true) => new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) });
const istTime = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
function safeEq(a: string, b: string) { if (!a || !b || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const cleanName = (s: string) => String(s || "").replace(/[\\/:*?"<>|#]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

// ---------- Apps Script bridge ----------
async function gas(payload: Doc) {
  const c = await cfg(); need(c.drive_url, "Google Drive isn't connected yet. The CEO connects it on the Policy settings page.", 409);
  const r = await fetch(c.drive_url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ ...payload, secret: c.drive_secret }), redirect: "follow" });
  const text = await r.text(); let out: any;
  try { out = JSON.parse(text); } catch { throw new Fail(`Drive bridge answered with something unexpected (HTTP ${r.status}). Check the Apps Script deployment allows "Anyone".`, 502); }
  if (!out.ok) throw new Fail("Drive: " + (out.error || "failed"), 502);
  return out;
}
const pdfLetter = (path: string[], name: string, letter: L.Letter, extra: L.Block[] = []) =>
  gas({ action: "letter", path, name, company: "Atraski India · At Buzz", blocks: [...letter.blocks, ...extra] });
const html = (paras: string[]) => `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#121A2F">${paras.map(p => `<p>${p}</p>`).join("")}<p style="color:#5D667C;font-size:12px">Atraski People · sent automatically</p></div>`;
async function mail(to: string | undefined, subject: string, paras: string[], attach: string[] = [], cc?: string) {
  if (!to) return null;
  try { return await gas({ action: "mail", to, cc, subject, html: html(paras), text: paras.join("\n\n").replace(/<[^>]+>/g, ""), attach, fromName: "Atraski People" }); }
  catch (e) { console.error("mail failed", e); return null; }   // email is best-effort; the record is already saved
}
const esc = (s: string) => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// ---------- who is calling ----------
type Caller = { uid: string; role: string; name: string; email: string; lvl: number };
const LVL: Record<string, number> = { owner: 4, hr: 3, admin: 3, member: 2, finance: 2, pending: 0 };
async function caller(req: Request): Promise<Caller> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  need(token, "Sign in first.", 401);
  const { data, error } = await admin.auth.getUser(token); need(!error && data && data.user, "Your session has ended. Sign in again.", 401);
  const u = data!.user!; const { data: m } = await admin.from("members").select("role,name,email").eq("user_id", u.id).maybeSingle();
  const role = (m && m.role) || "pending"; need(LVL[role] >= 2, "Your account doesn't have access yet.", 403);
  return { uid: u.id, role, name: (m && m.name) || "", email: (m && m.email) || u.email || "", lvl: LVL[role] };
}
const isCEO = (c: Caller) => c.role === "owner" || c.role === "hr";

// ---------- people records ----------
async function personOf(uid: string): Promise<{ p: L.Person; raw: Doc; email: string }> {
  const [r, ms, pol, pay, onb] = await Promise.all([roles(), members(), policy(), getDoc(`pay/${uid}`), getDoc(`onboard/${uid}`)]);
  const u = r[uid] || {}, m = ms.find(x => x.user_id === uid), f = (onb && onb.f) || {};
  const mgr = u.manager ? (ms.find(x => x.user_id === u.manager) || {} as any).name : "";
  const p: L.Person = { name: f.fullName || (m && m.name) || "Employee", email: f.email || (m && m.email) || "", phone: f.mobile || "",
    address: [f.curAddr, [f.curCity, f.curState, f.curPin].filter(Boolean).join(", ")].filter(Boolean).join("\n"),
    role: u.pos || "Team member", dept: u.dept || "", company: u.company || "Atraski India", etype: u.etype || "employee", tenure: Number(u.tenure) || 3,
    location: officeName(pol, u.base), manager: mgr || "", managerRole: u.manager ? ((r[u.manager] || {}).pos || "") : "", join: u.join || "", code: u.code || "",
    ctc: Number(pay && pay.salary) || 0, basic: u.basic, hra: u.hra, cycle: (pay && pay.cycle) || (u.etype === "intern" ? "15" : "10") };
  return { p, raw: u, email: p.email || "" };
}
const peoplePath = (name: string, id: string) => ["People", `${cleanName(name)} · ${id.slice(0, 6)}`];
async function folderFor(uid: string, name: string) { const h = await getDoc(`hrdocs/${uid}`); return (h && h.drivePath) || peoplePath(name, uid); }

const DOC_KEYS = ["offer", "appointment", "nda", "aadhaar", "pan", "bank", "photo", "education", "experience", "address", "emergency", "policy"];
const DOC_LABEL: Record<string, string> = { offer: "Offer letter", appointment: "Appointment letter", nda: "Signed NDA", aadhaar: "Aadhaar card", pan: "PAN card", bank: "Bank proof - cancelled cheque",
  photo: "Passport photo", education: "Educational certificates", experience: "Previous employment - relieving letter", address: "Address proof", emergency: "Emergency contact form", policy: "Policy acknowledgement" };
const MIME_OK = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif)|application\/(msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document))$/;
const EXT: Record<string, string> = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heif", "application/msword": ".doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx" };
function checkFile(b: Doc) {
  need(DOC_KEYS.includes(b.key), "Unknown document.");
  need(typeof b.data === "string" && b.data.length > 100, "The file is empty.");
  need(b.data.length <= 11_200_000, "Files can be up to 8 MB.");
  need(MIME_OK.test(b.mime || ""), "Upload a PDF, JPG, PNG or Word file.");
}

// =====================================================================================
// Employee: upload own onboarding document into their Drive folder
// =====================================================================================
async function opUpload(c: Caller, b: Doc) {
  checkFile(b);
  const { p } = await personOf(c.uid), path = await folderFor(c.uid, p.name);
  const name = `${DOC_LABEL[b.key]} - ${cleanName(p.name)}${EXT[b.mime] || ""}`;
  const r = await gas({ action: "file", path: [...path, "Documents"], name, mime: b.mime, data: b.data });
  const cur = (await getDoc(`hrdocs/${c.uid}`)) || {};
  await putDoc(`hrdocs/${c.uid}`, merge(cur, { drivePath: path, folder: cur.folder || r.folderUrl, items: { [b.key]: { url: r.url, status: "received", at: nowMs(), by: c.uid, file: name } } }));
  return { ok: true, url: r.url };
}

// =====================================================================================
// Candidate portal (no login; candidate id + secret token in the link)
// =====================================================================================
const CAND_FIELDS = ["fullName","fatherName","dob","gender","marital","blood","nationality","mobile","altMobile","email","curAddr","curCity","curState","curPin","sameAddr","permAddr","permCity","permState","permPin",
  "pan","aadhaar4","uan","emName","emRelation","emPhone","eduLevel","eduDegree","eduInst","eduYear","firstJob","prevCo","prevRole","prevFrom","prevTo","declare"];
const CAND_REQ_DOCS = ["aadhaar", "pan", "photo", "education", "address"];
async function candByToken(b: Doc) {
  need(typeof b.cid === "string" && /^[a-f0-9]{12}$/.test(b.cid) && typeof b.token === "string", "This link isn't valid.", 404);
  const cd = await getDoc(`cand/${b.cid}`); need(cd && safeEq(cd.token, b.token) && !cd.revoked, "This link isn't valid any more. Ask Atraski for a new one.", 404);
  return cd!;
}
function portalView(cd: Doc) {
  return { ok: true, cid: cd.cid, stage: cd.stage, name: cd.name, role: cd.role, dept: cd.dept, company: cd.company, join: cd.join, etype: cd.etype,
    details: cd.details || {}, docs: Object.fromEntries(Object.entries(cd.docs || {}).map(([k, v]: any) => [k, { file: v.file, at: v.at }])), reqDocs: CAND_REQ_DOCS,
    note: cd.portalNote || "", loi: cd.loi ? { ref: cd.loi.ref, blocks: cd.loi.blocks, issuedAt: cd.loi.issuedAt, acceptBy: cd.loi.acceptBy, acceptedAt: cd.loi.acceptedAt, declinedAt: cd.loi.declinedAt, signName: cd.loi.signName } : null,
    email: cd.email };
}
async function opPortal(b: Doc) {
  const cd = await candByToken(b), path = `cand/${cd.cid}`;
  const editable = ["invited", "returned"].includes(cd.stage);
  switch (b.act) {
    case "get": {
      if (!cd.openedAt) await patchDoc(path, { openedAt: nowMs() });
      return portalView(cd);
    }
    case "save": {
      need(editable, "Your details are with Atraski for review and can't be changed now.");
      const d: Doc = {}; for (const k of CAND_FIELDS) if (k in (b.details || {})) { const v = b.details[k]; d[k] = typeof v === "boolean" ? v : String(v ?? "").slice(0, 300); }
      if (d.pan) d.pan = String(d.pan).toUpperCase();
      if (d.aadhaar4 && !/^\d{4}$/.test(d.aadhaar4)) throw new Fail("Aadhaar: just the last 4 digits.");
      return portalView(await patchDoc(path, { details: d, savedAt: nowMs() }));
    }
    case "upload": {
      need(editable || cd.stage === "submitted", "Documents can't be changed now.");
      checkFile(b);
      const name = `${DOC_LABEL[b.key]} - ${cleanName(cd.name)}${EXT[b.mime] || ""}`;
      const r = await gas({ action: "file", path: [...cd.drivePath, "Documents"], name, mime: b.mime, data: b.data });
      return portalView(await patchDoc(path, { folder: cd.folder || r.folderUrl, docs: { [b.key]: { url: r.url, file: name, at: nowMs() } } }));
    }
    case "submit": {
      need(editable, "Already submitted.");
      const d = cd.details || {}, miss: string[] = [];
      for (const [k, l] of [["fullName","full name"],["dob","date of birth"],["mobile","mobile"],["email","email"],["curAddr","current address"],["pan","PAN"],["aadhaar4","Aadhaar last 4 digits"],["emName","emergency contact"],["emPhone","emergency phone"]]) if (!String(d[k] || "").trim()) miss.push(l);
      if (!d.declare) miss.push("the declaration");
      for (const k of CAND_REQ_DOCS) if (!(cd.docs || {})[k]) miss.push(DOC_LABEL[k]);
      need(!miss.length, "Still needed: " + miss.join(", ") + ".");
      const next = await patchDoc(path, { stage: "submitted", submittedAt: nowMs(), history: [...(cd.history || []), { at: nowMs(), what: "Candidate submitted details and documents" }] });
      const s = await signer(), ceo = (await members()).find(x => x.role === "owner");
      await mail(ceo && ceo.email, `Candidate ready for review: ${cd.name}`, [`${esc(cd.name)} (${esc(cd.role)}) has submitted their details and documents.`, `Review them and issue the Letter of Intent from <b>Hiring &amp; exits</b> in Atraski People.`]);
      void s; return portalView(next);
    }
    case "loi": {
      need(cd.stage === "loi_sent" && cd.loi, "There's no letter waiting for you.");
      const at = nowMs();
      if (b.decline) {
        const next = await patchDoc(path, { stage: "declined", loi: { declinedAt: at, declineReason: String(b.reason || "").slice(0, 300) }, history: [...(cd.history || []), { at, what: "Candidate declined the LOI" }] });
        const ceo = (await members()).find(x => x.role === "owner");
        await mail(ceo && ceo.email, `LOI declined: ${cd.name}`, [`${esc(cd.name)} declined the Letter of Intent for ${esc(cd.role)}.`, b.reason ? `Reason: ${esc(b.reason)}` : ""]);
        return portalView(next);
      }
      const sign = String(b.signName || "").trim();
      need(sign.length >= 3 && sign.toLowerCase().replace(/\s+/g, " ") === String(cd.name).toLowerCase().replace(/\s+/g, " "), `Type your full name exactly as "${cd.name}" to sign.`);
      const s = await signer();
      const letter: L.Letter = { kind: "LOI", title: L.KIND_NAME.LOI, blocks: cd.loi.blocks };
      const pdf = await pdfLetter([...cd.drivePath, "Letters"], `LOI ${cd.loi.ref} - ${cleanName(cd.name)} - signed`, letter, [L.signBlock(sign, at, "Intent to join confirmed")]);
      const next = await patchDoc(path, { stage: "loi_accepted", loi: { acceptedAt: at, signName: sign, signedUrl: pdf.url, signedId: pdf.id }, history: [...(cd.history || []), { at, what: "Candidate accepted the LOI" }] });
      await mail(cd.email, `Your signed Letter of Intent – ${cd.role}`, [`Dear ${esc(cd.name.split(" ")[0])},`, `Thank you for confirming. Your signed Letter of Intent is attached.`,
        `<b>On your joining day (${L.dmy(cd.join)})</b>, create your Atraski People account with this email address (${esc(cd.email)}) at <a href="${esc(cd.appUrl || "")}">${esc(cd.appUrl || "Atraski People")}</a>. Your appointment letter will be waiting there.`, `${esc(s.name)}<br>${esc(s.title)}, Atraski India`], [pdf.id]);
      const ceo = (await members()).find(x => x.role === "owner");
      await mail(ceo && ceo.email, `LOI accepted: ${cd.name}`, [`${esc(cd.name)} accepted the Letter of Intent for ${esc(cd.role)}. Joining on ${L.dmy(cd.join)}.`, `When they sign up, confirm their joining from <b>Hiring &amp; exits</b>.`]);
      return portalView(next);
    }
    default: throw new Fail("Unknown request.");
  }
}

// =====================================================================================
// CEO: candidates → LOI → joining
// =====================================================================================
async function opCandCreate(c: Caller, b: Doc) {
  need(isCEO(c), "Only the CEO can add candidates.", 403);
  const name = cleanName(b.name), email = String(b.email || "").trim().toLowerCase();
  need(name.length >= 2, "Add the candidate's name."); need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "Add a valid email.");
  need(/^https:\/\//.test(String(b.appUrl || "")), "Missing app address.");
  const cid = randHex(6), token = randHex(24);
  const cd = { cid, token, stage: "invited", name, email, phone: String(b.phone || "").slice(0, 20), role: String(b.role || "").slice(0, 80), dept: String(b.dept || "").slice(0, 60),
    company: b.company === "At Buzz" ? "At Buzz" : "Atraski", etype: ["intern", "trainee", "employee"].includes(b.etype) ? b.etype : "employee", tenure: Number(b.tenure) === 6 ? 6 : 3,
    base: String(b.base || ""), workMode: String(b.workMode || "Work from office").slice(0, 40), manager: String(b.manager || ""), ctc: Math.max(0, Math.round(Number(b.ctc) || 0)),
    join: /^\d{4}-\d{2}-\d{2}$/.test(b.join || "") ? b.join : "", appUrl: String(b.appUrl).replace(/[#?].*$/, ""), drivePath: peoplePath(name, cid), createdAt: nowMs(), createdBy: c.uid,
    history: [{ at: nowMs(), what: "Candidate added and invited" }] };
  await putDoc(`cand/${cid}`, cd);
  const link = `${cd.appUrl.replace(/index\.html$/, "").replace(/\/?$/, "/")}join.html#${cid}.${token}`;
  const s = await signer();
  const sent = await mail(email, `Atraski India – your joining details for ${cd.role}`, [`Dear ${esc(name.split(" ")[0])},`,
    `Thank you for your interest in the ${esc(cd.role)} role at ${esc(cd.company)}. Please share your details and documents through your private link:`,
    `<a href="${link}" style="display:inline-block;background:#0F1730;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open my joining form</a>`,
    `You'll need: Aadhaar, PAN, a passport-size photo, your highest educational certificate, address proof, and your last relieving letter if you have one. Your Letter of Intent will appear on the same page once we've reviewed them.`,
    `${esc(s.name)}<br>${esc(s.title)}, Atraski India`]);
  return { ok: true, cid, link, emailed: !!sent };
}
async function opLoiIssue(c: Caller, b: Doc) {
  need(isCEO(c), "Only the CEO can issue letters.", 403);
  const cd = await getDoc(`cand/${b.cid}`); need(cd, "Candidate not found.", 404);
  need(["submitted", "loi_sent", "invited", "returned"].includes(cd!.stage), "This candidate is past the LOI stage.");
  const pol = await policy(), s = await signer(), ref = await nextRef("LOI"), date = L.todayIST();
  const acceptBy = /^\d{4}-\d{2}-\d{2}$/.test(b.acceptBy || "") ? b.acceptBy : L.addDays(date, 3);
  const p: L.Person = { name: cd!.name, email: cd!.email, phone: cd!.phone, role: cd!.role, dept: cd!.dept, company: cd!.company === "At Buzz" ? "At Buzz" : "Atraski India", etype: cd!.etype,
    tenure: cd!.tenure, location: officeName(pol, cd!.base), workMode: cd!.workMode, join: cd!.join, ctc: cd!.ctc };
  need(p.role && p.join && p.ctc, "Set the role, joining date and monthly CTC first.");
  const letter = L.letterLOI(p, s, { ref, date, acceptBy, docsDays: 3 });
  const pdf = await pdfLetter([...cd!.drivePath, "Letters"], `LOI ${ref} - ${cleanName(cd!.name)}`, letter);
  const next = await patchDoc(`cand/${b.cid}`, { stage: "loi_sent", loi: { ref, blocks: letter.blocks, issuedAt: nowMs(), acceptBy, url: pdf.url, id: pdf.id, acceptedAt: null, declinedAt: null }, history: [...(cd!.history || []), { at: nowMs(), what: `LOI ${ref} issued` }] });
  const link = `${cd!.appUrl.replace(/index\.html$/, "").replace(/\/?$/, "/")}join.html#${cd!.cid}.${cd!.token}`;
  await mail(cd!.email, `Letter of Intent – ${cd!.role} at ${p.company}`, [`Dear ${esc(cd!.name.split(" ")[0])},`, `We're pleased to share your Letter of Intent (attached). Please read it and confirm your intent to join by <b>${L.dmy(acceptBy)}</b>:`,
    `<a href="${link}" style="display:inline-block;background:#0F1730;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Review and confirm</a>`, `${esc(s.name)}<br>${esc(s.title)}, Atraski India`], [pdf.id]);
  return { ok: true, ref, url: pdf.url, stage: next.stage };
}
async function opJoin(c: Caller, b: Doc) {
  need(isCEO(c), "Only the CEO can confirm joining.", 403);
  const cd = await getDoc(`cand/${b.cid}`); need(cd, "Candidate not found.", 404);
  need(["loi_accepted", "submitted", "loi_sent"].includes(cd!.stage), "Confirm joining after the candidate has accepted the LOI.");
  const ms = await members(); const m = ms.find(x => x.user_id === b.uid); need(m, "Pick the account they signed up with.");
  const uid = m!.user_id, today = L.todayIST(), join = cd!.join && cd!.join <= today ? cd!.join : today;
  const r = await roles(), code = String(b.code || "").trim().slice(0, 20) || await nextCode(r);
  // 1) access + employee record
  if (["pending"].includes(m!.role)) { const { error } = await admin.from("members").update({ role: "member" }).eq("user_id", uid); if (error) throw error; }
  await patchDoc("config/roles", { users: { [uid]: { role: "employee", code, company: cd!.company, dept: cd!.dept || null, pos: cd!.role || null, etype: cd!.etype, tenure: cd!.tenure, join, base: cd!.base || null, manager: cd!.manager || null, cid: cd!.cid } } });
  // 2) onboarding details + documents carry over
  const d = cd!.details || {};
  await putDoc(`onboard/${uid}`, { status: "verified", f: d, submittedAt: cd!.submittedAt || nowMs(), savedAt: nowMs(), hr: { by: c.uid, at: nowMs(), note: "Carried over from the candidate portal" } });
  const items: Doc = {}; for (const [k, v] of Object.entries(cd!.docs || {}) as any) items[k] = { url: v.url, status: "received", at: v.at, by: uid, file: v.file };
  if (cd!.loi && cd!.loi.signedUrl) items.offer = { url: cd!.loi.signedUrl, status: "verified", at: cd!.loi.acceptedAt, by: "system", file: "Signed LOI" };
  if (d.emName) items.emergency = { status: "received", at: nowMs(), by: uid, note: `${d.emName} (${d.emRelation || ""}) ${d.emPhone || ""}` };
  await putDoc(`hrdocs/${uid}`, merge((await getDoc(`hrdocs/${uid}`)) || {}, { drivePath: cd!.drivePath, folder: cd!.folder || null, items }));
  // 3) salary (CEO-only collection)
  if (cd!.ctc) await patchDoc(`pay/${uid}`, { salary: cd!.ctc, cycle: cd!.etype === "intern" ? "15" : "10" });
  await patchDoc(`cand/${b.cid}`, { stage: "joined", uid, joinedAt: nowMs(), history: [...(cd!.history || []), { at: nowMs(), what: `Joined as ${code}` }] });
  await putDoc(`life/${uid}`, merge((await getDoc(`life/${uid}`)) || {}, { cid: cd!.cid, joinedAt: nowMs() }));
  // 4) appointment / internship / traineeship letter
  const issued = await issueLetter(uid, "APPOINT");
  return { ok: true, uid, code, letter: issued };
}
async function nextCode(r: Record<string, any>) {
  let max = 0; for (const u of Object.values(r) as any[]) { const m = String(u.code || "").match(/(\d+)\s*$/); if (m) max = Math.max(max, Number(m[1])); }
  return `AT-${String(max + 1).padStart(3, "0")}`;
}

// =====================================================================================
// Letters to employees (issue → employee accepts in the app)
// =====================================================================================
async function issueLetter(uid: string, what: "APPOINT" | "CNF" | "EXT", extra: Doc = {}) {
  const { p, email } = await personOf(uid), s = await signer(), date = L.todayIST();
  let letter: L.Letter;
  if (what === "APPOINT") { const kind = p.etype === "intern" ? "INT" : p.etype === "trainee" ? "TRN" : "APT"; letter = L.letterAppointment(p, s, { ref: await nextRef(kind), date }); }
  else if (what === "CNF") letter = L.letterConfirmation(p, s, { ref: await nextRef("CNF"), date, from: extra.from || date });
  else letter = L.letterExtension(p, s, { ref: await nextRef("EXT"), date, until: extra.until, reason: extra.reason || "" });
  const ref = (letter.blocks[0].text || "").match(/Ref No: (\S+)/)?.[1] || "";
  const path = await folderFor(uid, p.name);
  const pdf = await pdfLetter([...path, "Letters"], `${letter.title} ${ref} - ${cleanName(p.name)}`, letter);
  const life = (await getDoc(`life/${uid}`)) || {}, letters = [...(life.letters || []), { kind: letter.kind, title: letter.title, ref, blocks: letter.blocks, url: pdf.url, id: pdf.id, issuedAt: nowMs(), needsAccept: ["APT", "INT", "TRN"].includes(letter.kind) }];
  await putDoc(`life/${uid}`, { ...life, letters });
  if (what === "APPOINT") await patchDoc(`hrdocs/${uid}`, { items: { appointment: { url: pdf.url, status: "received", at: nowMs(), by: "system", file: letter.title } } });
  await mail(email, `${letter.title} – ${p.company}`, [`Dear ${esc(p.name.split(" ")[0])},`, `Your ${letter.title.toLowerCase()} is attached${["APT","INT","TRN"].includes(letter.kind) ? ". Please read it and accept it in Atraski People (My onboarding)." : "."}`, `${esc(s.name)}<br>${esc(s.title)}, Atraski India`], [pdf.id]);
  return { kind: letter.kind, ref, url: pdf.url };
}
async function opLetterIssue(c: Caller, b: Doc) {
  need(isCEO(c), "Only the CEO can issue letters.", 403);
  need(["APPOINT"].includes(b.what), "Unknown letter.");
  return { ok: true, letter: await issueLetter(b.uid, b.what) };
}
async function opLetterAccept(c: Caller, b: Doc) {
  const life = await getDoc(`life/${c.uid}`); need(life && life.letters && life.letters[b.idx], "Letter not found.", 404);
  const lt = life!.letters[b.idx]; need(lt.needsAccept && !lt.acceptedAt, "Nothing to accept.");
  const { p, email } = await personOf(c.uid); const sign = String(b.signName || "").trim();
  need(sign.toLowerCase().replace(/\s+/g, " ") === p.name.toLowerCase().replace(/\s+/g, " "), `Type your full name exactly as "${p.name}" to sign.`);
  need(b.ackPolicies === true, "Tick the box to confirm you've read the policies.");
  const at = nowMs(), path = await folderFor(c.uid, p.name);
  const pdf = await pdfLetter([...path, "Letters"], `${lt.title} ${lt.ref} - ${cleanName(p.name)} - signed`, { kind: lt.kind, title: lt.title, blocks: lt.blocks },
    [L.signBlock(sign, at, "Terms accepted, and Atraski People Policies ATR-HR-01 to ATR-HR-12 acknowledged,")]);
  life!.letters[b.idx] = { ...lt, acceptedAt: at, signName: sign, signedUrl: pdf.url, signedId: pdf.id };
  await putDoc(`life/${c.uid}`, life!);
  await patchDoc(`hrdocs/${c.uid}`, { items: { appointment: { url: pdf.url, status: "verified", at, by: "system", file: `${lt.title} (signed)` },
    nda: { url: pdf.url, status: "verified", at, by: "system", file: "Confidentiality clause accepted in the signed letter" },
    policy: { url: pdf.url, status: "verified", at, by: "system", file: "Policies acknowledged when signing" } } });
  await mail(email, `Signed copy: ${lt.title}`, [`Dear ${esc(p.name.split(" ")[0])},`, "Your signed copy is attached for your records. Welcome aboard!"], [pdf.id]);
  return { ok: true, url: pdf.url };
}

// =====================================================================================
// Probation outcome (CEO, or the manager proposes and the CEO confirms in the app)
// =====================================================================================
async function opProbation(c: Caller, b: Doc) {
  need(isCEO(c), "Only the CEO can record the probation outcome.", 403);
  const today = L.todayIST();
  if (b.outcome === "confirm") {
    await patchDoc("config/roles", { users: { [b.uid]: { confirmed: today, probEnd: today } } });
    return { ok: true, letter: await issueLetter(b.uid, "CNF", { from: today }) };
  }
  if (b.outcome === "extend") {
    const months = Math.min(3, Math.max(1, Number(b.months) || 1)), r = await roles(), u = r[b.uid] || {};
    const until = L.addMonths(u.probEnd || L.addMonths(u.join || today, 6), months);
    need(String(b.reason || "").trim().length >= 10, "Write the reasons and goals for the extension.");
    await patchDoc("config/roles", { users: { [b.uid]: { probEnd: until, probExtended: true } } });
    return { ok: true, letter: await issueLetter(b.uid, "EXT", { until, reason: b.reason }) };
  }
  if (b.outcome === "end") return await startExit(b.uid, { by: "company", reason: String(b.reason || "Probation not confirmed"), noticeDays: 15 });
  throw new Fail("Unknown outcome.");
}

// =====================================================================================
// Exit: resignation → notice → handover sign-offs → No Dues → F&F → relieving + experience → access closed
// =====================================================================================
const HANDOVER: { k: string; label: string; who: "manager" | "ceo" | "finance" }[] = [
  { k: "h1", label: "Handover note: tasks, status, deadlines, client contacts and logins", who: "manager" },
  { k: "h2", label: "Walkthrough of each live account or project to the successor", who: "manager" },
  { k: "h3", label: "All files moved to the Atraski Drive; local copies deleted", who: "ceo" },
  { k: "h4", label: "All company assets returned with accessories (ATR-HR-07)", who: "ceo" },
  { k: "h5", label: "Advances, claims and recoveries listed (ATR-HR-09)", who: "finance" },
];
function workingDaysBetween(a: string, b: string) { let n = 0; for (let d = a; d < b; d = L.addDays(d, 1)) if (new Date(d + "T00:00:00Z").getUTCDay() !== 0) n++; return n; }
async function startExit(uid: string, o: { by: "employee" | "company"; reason: string; noticeDays?: number; start?: string }) {
  const cur = await getDoc(`exit/${uid}`); need(!cur || ["withdrawn", "closed"].includes(cur.stage), "An exit is already in progress.");
  const r = await roles(), u = r[uid] || {}, start = o.start || L.todayIST();
  const notice = o.noticeDays || L.noticeDays({ join: u.join, etype: u.etype, probEnd: u.probEnd, confirmed: u.confirmed, notice: u.notice }, start);
  const lwd = L.addDays(start, notice - 1);
  const ex = { stage: "notice", by: o.by, reason: o.reason.slice(0, 600), resignedOn: start, notice, lwd, at: nowMs(), handover: {}, history: [{ at: nowMs(), what: o.by === "employee" ? "Resigned" : "Separation started by the company" }] };
  await putDoc(`exit/${uid}`, ex);
  const { p, email } = await personOf(uid), s = await signer(), ms = await members();
  const mgr = u.manager ? ms.find(x => x.user_id === u.manager) : null, ceo = ms.find(x => x.role === "owner");
  const letter = L.letterResignationAck(p, s, { date: start, resigned: start, notice, lwd });
  let pdfId: string | null = null;
  try { const pdf = await pdfLetter([...(await folderFor(uid, p.name)), "Exit"], `Resignation acknowledgement - ${cleanName(p.name)}`, letter); pdfId = pdf.id; await patchDoc(`exit/${uid}`, { ackUrl: pdf.url }); } catch (e) { console.error(e); }
  await mail(email, `Resignation acknowledged – last working day ${L.dmy(lwd)}`, [`Dear ${esc(p.name.split(" ")[0])},`, `We've received your resignation. Your notice period is <b>${notice} day${notice === 1 ? "" : "s"}</b> and your last working day is <b>${L.dmy(lwd)}</b> (ATR-HR-10).`,
    "Please submit your handover in Atraski People at least 5 working days before your last working day. Paid leave isn't taken during notice.", `${esc(s.name)}<br>${esc(s.title)}, Atraski India`], pdfId ? [pdfId] : [], [mgr && mgr.email, ceo && ceo.email].filter(Boolean).join(",") || undefined);
  return { ok: true, lwd, notice };
}
async function opResign(c: Caller, b: Doc) {
  need(String(b.reason || "").trim().length >= 5, "Add a short reason.");
  return await startExit(c.uid, { by: "employee", reason: String(b.reason) });
}
async function opHandoverSubmit(c: Caller, b: Doc) {
  const ex = await getDoc(`exit/${c.uid}`); need(ex && ex.stage === "notice", "No exit in progress.");
  const note = String(b.note || "").trim(); need(note.length >= 20, "Describe your tasks, their status, client contacts and where the files are.");
  const link = String(b.link || "").trim(); need(!link || /^https:\/\/(drive|docs)\.google\.com\//.test(link), "Use a Google Drive link.");
  const late = workingDaysBetween(L.todayIST(), ex!.lwd) < 5;
  await patchDoc(`exit/${c.uid}`, { handoverNote: { text: note.slice(0, 4000), link, at: nowMs(), late }, history: [...(ex!.history || []), { at: nowMs(), what: "Handover submitted" + (late ? " (less than 5 working days before LWD)" : "") }] });
  return { ok: true, late };
}
async function opExitSign(c: Caller, b: Doc) {
  const item = HANDOVER.find(h => h.k === b.item); need(item, "Unknown handover item.");
  const ex = await getDoc(`exit/${b.uid}`); need(ex && ex.stage === "notice", "No exit in progress for this person.");
  const r = await roles(), u = r[b.uid] || {};
  const allowed = isCEO(c) || (item!.who === "manager" && u.manager === c.uid) || (item!.who === "finance" && c.role === "finance");
  need(allowed, "You can't sign off this item.", 403);
  need(b.uid !== c.uid, "You can't sign off your own handover.", 403);
  if (item!.k === "h1" || item!.k === "h2") need(ex!.handoverNote, "The employee hasn't submitted the handover yet.");
  const ok = b.ok !== false, at = nowMs();
  const rec: Doc = { ok, by: c.uid, byName: c.name, at, note: String(b.note || "").slice(0, 300) };
  if (item!.k === "h5") rec.amounts = { advances: Math.max(0, Number(b.advances) || 0), assets: Math.max(0, Number(b.assets) || 0), other: Math.max(0, Number(b.other) || 0) };
  if (item!.k === "h4") rec.amounts = { assets: Math.max(0, Number(b.assets) || 0) };
  let next = await patchDoc(`exit/${b.uid}`, { handover: { [item!.k]: rec }, history: [...(ex!.history || []), { at, what: `${item!.label.split(":")[0]}: ${ok ? "signed off" : "not accepted"} by ${c.name}` }] });
  // 6) No Dues Certificate once 1–5 are signed
  if (HANDOVER.every(h => next.handover && next.handover[h.k] && next.handover[h.k].ok) && !next.ndc) {
    const { p } = await personOf(b.uid), s = await signer(), ref = await nextRef("NDC");
    const ms = await members(), nm = (id: string) => (ms.find(x => x.user_id === id) || {} as any).name || "";
    const letter = L.letterNoDues(p, s, { ref, date: L.todayIST(), lwd: next.lwd, signoffs: HANDOVER.map(h => [h.label.split(":")[0].split(";")[0], `${nm(next.handover[h.k].by)} · ${ist(next.handover[h.k].at, false)}`] as [string, string]) });
    const pdf = await pdfLetter([...(await folderFor(b.uid, p.name)), "Exit"], `No Dues Certificate ${ref} - ${cleanName(p.name)}`, letter);
    next = await patchDoc(`exit/${b.uid}`, { stage: "nodues", ndc: { ref, url: pdf.url, id: pdf.id, at: nowMs() } });
  }
  return { ok: true, stage: next.stage };
}
async function opExitLwd(c: Caller, b: Doc) {
  need(c.role === "owner", "Only the CEO can shorten or waive notice (ATR-HR-10 §2).", 403);
  need(/^\d{4}-\d{2}-\d{2}$/.test(b.lwd || ""), "Pick a date.");
  const ex = await getDoc(`exit/${b.uid}`); need(ex && ["notice", "nodues"].includes(ex.stage), "No exit in progress.");
  await patchDoc(`exit/${b.uid}`, { lwd: b.lwd, lwdChanged: { from: ex!.lwd, by: c.uid, at: nowMs(), note: String(b.note || "").slice(0, 300) }, history: [...(ex!.history || []), { at: nowMs(), what: `Last working day changed to ${L.dmy(b.lwd)} by the CEO` }] });
  const { p, email } = await personOf(b.uid);
  await mail(email, `Last working day updated – ${L.dmy(b.lwd)}`, [`Dear ${esc(p.name.split(" ")[0])},`, `Your last working day is now <b>${L.dmy(b.lwd)}</b>.${b.note ? " " + esc(b.note) : ""}`]);
  return { ok: true };
}
async function opExitStart(c: Caller, b: Doc) {
  need(c.role === "owner", "Only the CEO can start a separation.", 403);
  return await startExit(b.uid, { by: "company", reason: String(b.reason || "Separation"), noticeDays: Number(b.noticeDays) || undefined, start: b.start });
}
async function opExitCancel(c: Caller, b: Doc) {
  need(c.role === "owner", "Only the CEO can withdraw an exit.", 403);
  const ex = await getDoc(`exit/${b.uid}`); need(ex && ["notice", "nodues"].includes(ex.stage), "No exit in progress.");
  await patchDoc(`exit/${b.uid}`, { stage: "withdrawn", history: [...(ex!.history || []), { at: nowMs(), what: "Exit withdrawn by the CEO" }] });
  return { ok: true };
}
async function opFnf(c: Caller, b: Doc) {
  need(c.role === "owner", "Only the CEO can approve the full-and-final settlement.", 403);
  const ex = await getDoc(`exit/${b.uid}`); need(ex && ex.stage === "nodues", "The No Dues Certificate comes first: all five handover items must be signed off.");
  const lines = (x: any) => (Array.isArray(x) ? x : []).filter((l: any) => l && l[0]).map((l: any) => [String(l[0]).slice(0, 80), Math.round(Number(l[1]) || 0)] as L.FnfLine);
  const earn = lines(b.earn), less = lines(b.less); need(earn.length, "Add the earnings.");
  const { p } = await personOf(b.uid), s = await signer(), ref = await nextRef("FNF"), due = L.addDays(ex!.lwd, 45);
  const letter = L.letterFnf(p, s, { ref, date: L.todayIST(), lwd: ex!.lwd, earn, less, due, notes: String(b.notes || "").slice(0, 500) });
  const pdf = await pdfLetter([...(await folderFor(b.uid, p.name)), "Exit"], `FnF statement ${ref} - ${cleanName(p.name)}`, letter);
  const net = earn.reduce((a, x) => a + x[1], 0) - less.reduce((a, x) => a + x[1], 0);
  await patchDoc(`exit/${b.uid}`, { stage: "fnf", fnf: { ref, url: pdf.url, id: pdf.id, earn, less, net, due, at: nowMs() }, history: [...(ex!.history || []), { at: nowMs(), what: `F&F statement ${ref} approved: net ${L.inr(net)}` }] });
  const { email } = await personOf(b.uid);
  await mail(email, "Your full-and-final settlement statement", [`Dear ${esc(p.name.split(" ")[0])},`, `Your F&amp;F statement is attached. Net ${net >= 0 ? "payable to you" : "recoverable"}: <b>${L.inr(Math.abs(net))}</b>, by ${L.dmy(due)}.`, "Your relieving letter and experience certificate are issued with the payment."], [pdf.id]);
  return { ok: true, net, url: pdf.url };
}
async function opFnfPaid(c: Caller, b: Doc) {
  need(c.role === "owner", "Only the CEO can record the F&F payment.", 403);
  const ex = await getDoc(`exit/${b.uid}`); need(ex && ex.stage === "fnf", "Approve the F&F statement first.");
  const { p, email } = await personOf(b.uid), s = await signer(), path = [...(await folderFor(b.uid, p.name)), "Exit"], date = L.todayIST();
  const rl = L.letterRelieving(p, s, { ref: await nextRef("RL"), date, lwd: ex!.lwd }), xp = L.letterExperience(p, s, { ref: await nextRef("EXP"), date, lwd: ex!.lwd });
  const [a, bb] = [await pdfLetter(path, `Relieving letter - ${cleanName(p.name)}`, rl), await pdfLetter(path, `Experience certificate - ${cleanName(p.name)}`, xp)];
  await patchDoc(`exit/${b.uid}`, { stage: "closed", paidOn: /^\d{4}-\d{2}-\d{2}$/.test(b.paidOn || "") ? b.paidOn : date, relieving: { url: a.url, id: a.id }, experience: { url: bb.url, id: bb.id }, closedAt: nowMs(),
    history: [...(ex!.history || []), { at: nowMs(), what: "F&F paid; relieving letter and experience certificate issued; access closed" }] });
  await patchDoc("config/roles", { users: { [b.uid]: { exited: ex!.lwd } } });
  const { error } = await admin.from("members").update({ role: "pending" }).eq("user_id", b.uid); if (error) console.error(error);
  const alt = String((((await getDoc(`onboard/${b.uid}`)) || {}).f || {}).email || "");
  await mail(alt || email, "Relieving letter and experience certificate", [`Dear ${esc(p.name.split(" ")[0])},`, "Your full-and-final settlement has been paid. Your relieving letter and experience certificate are attached. Thank you for your time at Atraski, and all the best!", `${esc(s.name)}<br>${esc(s.title)}, Atraski India`], [a.id, bb.id]);
  return { ok: true };
}

// =====================================================================================
// Drive: CEO pushes computed sheets; nightly export of the raw records
// =====================================================================================
async function opPush(c: Caller, b: Doc) {
  need(c.role === "owner", "Only the CEO can save reports to Drive.", 403);
  need(Array.isArray(b.path) && b.path.length <= 4 && b.path.every((x: unknown) => typeof x === "string" && x.length <= 80), "Bad folder.");
  need(Array.isArray(b.tabs) && b.tabs.length && b.tabs.length <= 6, "Nothing to save.");
  return await gas({ action: "sheet", path: b.path, name: String(b.name || "Report").slice(0, 100), tabs: b.tabs });
}
const OB_LABELS: [string, string][] = [["fullName","Full name"],["fatherName","Father's / spouse's name"],["dob","Date of birth"],["gender","Gender"],["marital","Marital status"],["blood","Blood group"],["nationality","Nationality"],
  ["mobile","Mobile"],["altMobile","Alternate mobile"],["email","Personal email"],["curAddr","Current address"],["curCity","City"],["curState","State"],["curPin","PIN"],["permAddr","Permanent address"],["permCity","Permanent city"],["permState","Permanent state"],["permPin","Permanent PIN"],
  ["pan","PAN"],["aadhaar4","Aadhaar (last 4)"],["uan","UAN"],["emName","Emergency contact"],["emRelation","Relationship"],["emPhone","Emergency phone"],["eduLevel","Highest qualification"],["eduDegree","Degree"],["eduInst","Institute"],["eduYear","Year"],
  ["prevCo","Last company"],["prevRole","Last designation"],["prevFrom","From"],["prevTo","To"]];
async function nightly() {
  const today = L.todayIST(), ym = today.slice(0, 7), yr = today.slice(0, 4), d = Number(today.slice(8));
  const months = [ym, ...(d <= 7 ? [new Date(Date.UTC(+yr, +today.slice(5, 7) - 2, 1)).toISOString().slice(0, 7)] : [])];
  const [ms, r, pol, att, dec, fin, onb, hd, cands, exits, lifes] = await Promise.all([members(), roles(), policy(), listDocs("att"), listDocs("decisions"), listDocs("finance"), listDocs("onboard"), listDocs("hrdocs"), listDocs("cand"), listDocs("exit"), listDocs("life")]);
  const uidOf = (p: string) => p.split("/")[1], byUid = (rows: { path: string; data: Doc }[]) => Object.fromEntries(rows.filter(x => x.path.split("/").length === 2).map(x => [uidOf(x.path), x.data]));
  const D = byUid(dec), F = byUid(fin), O = byUid(onb), H = byUid(hd), X = byUid(exits), LF = byUid(lifes), roots = byUid(att);
  const nm = (id: string) => (ms.find(x => x.user_id === id) || {} as any).name || (roots[id] && roots[id].title) || id.slice(0, 6), code = (id: string) => (r[id] || {}).code || "";
  const ids = [...new Set([...ms.filter(m => m.role !== "pending" || (r[m.user_id] && r[m.user_id].exited)).map(m => m.user_id), ...Object.keys(roots)])].sort((a, b) => nm(a).localeCompare(nm(b)));
  const items: Doc[] = [];
  // Employee register
  items.push({ action: "sheet", path: ["Employees"], name: "Employee register", tabs: [{ name: "Employees", rows: [["Code","Name","Email","Access","Company","Department","Position","Category","Joined","Probation ends","Confirmed","Manager","Office","Onboarding form","Documents received","Exit stage","Last working day","Drive folder"],
    ...ids.map(id => { const u = r[id] || {}, m = ms.find(x => x.user_id === id) || {} as any, h = H[id] || {}, it = h.items || {}, ex = X[id] || {};
      return [code(id), nm(id), m.email || "", m.role || "", u.company || "", u.dept || "", u.pos || "", u.etype || "", u.join || "", u.probEnd || (u.join && u.etype === "employee" ? L.addMonths(u.join, 6) : ""), u.confirmed || "", u.manager ? nm(u.manager) : "", officeName(pol, u.base),
        (O[id] || {}).status || "not started", `${Object.values(it).filter((x: any) => x && (x.status === "received" || x.status === "verified")).length}/12`, ex.stage || "", ex.lwd || "", h.folder || ""]; })] }] });
  // Onboarding details, one sheet per person in their folder
  for (const id of ids) { const o = O[id]; if (!o || !o.f) continue; const path = (H[id] && H[id].drivePath) || peoplePath(nm(id), id);
    items.push({ action: "sheet", path, name: "Onboarding details", tabs: [{ name: "Details", rows: [["Field", "Value"], ["Status", o.status || ""], ...OB_LABELS.filter(([k]) => o.f[k]).map(([k, l]) => [l, k === "aadhaar4" ? "XXXX XXXX " + o.f[k] : String(o.f[k])])] },
      { name: "Letters", rows: [["Letter","Ref","Issued","Accepted","PDF"], ...((LF[id] || {}).letters || []).map((x: any) => [x.title, x.ref, x.issuedAt ? ist(x.issuedAt, false) : "", x.acceptedAt ? ist(x.acceptedAt) : "", x.signedUrl || x.url || ""])] }] }); }
  // Punch log per month
  for (const m of months) {
    const rows: any[][] = [["Code","Employee","Date","Day","Punch in","Punch out","Hours","Mode","Location","Punch-out location","Note"]];
    for (const a of att) { const parts = a.path.split("/"); if (parts.length !== 4 || parts[2] !== "months" || parts[3] !== m) continue; const id = parts[1];
      for (const [dd, rec] of Object.entries((a.data.days || {}) as Record<string, any>).sort()) { const ds = `${m}-${dd}`, day = new Date(ds + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" });
        for (const s of (rec && rec.s) || []) rows.push([code(id), nm(id), ds, day, s.i ? istTime(s.i) : "", s.o ? istTime(s.o) : "Not punched out", s.o && s.i ? ((s.o - s.i) / 36e5).toFixed(2) : "", s.m === "wfh" ? "WFH" : "Office", s.m === "wfh" ? "Home" : (s.l === "client" ? "Client site" : officeName(pol, s.l)), s.lo ? (s.lo === "client" ? "Client site" : s.lo === "home" ? "Home" : officeName(pol, s.lo)) : "", s.ln || ""]); } }
    rows.splice(1, rows.length - 1, ...rows.slice(1).sort((x, y) => String(x[1]).localeCompare(String(y[1])) || String(x[2]).localeCompare(String(y[2])) || String(x[4]).localeCompare(String(y[4]))));
    items.push({ action: "sheet", path: ["Attendance", m], name: `Punch log ${m}`, tabs: [{ name: "Punches", rows }] });
  }
  // Leave, WFH, short leave and regularisation requests this year
  const req: any[][] = [["Code","Employee","Request","Type","From","To","Detail","Status","Decided by","Decided on","Applied on","Reason","Flags"]];
  for (const id of Object.keys(roots)) for (const [rid, q] of Object.entries((roots[id].requests || {}) as Record<string, any>)) {
    if (!String(q.from || "").startsWith(yr)) continue; const dd = (D[id] || {})[rid] || {};
    const st = q.withdrawn ? "withdrawn" : dd.s || "pending";
    req.push([code(id), nm(id), q.kind, q.type || "", q.from || "", q.to || "", q.kind === "half" ? (q.half || "") + " half" : q.kind === "short" ? `${q.start}–${q.end}` : q.kind === "reg" ? `punch-out ${q.out}` : "", st, dd.by === "auto" ? "Auto (within policy)" : dd.by ? nm(dd.by) : "", dd.at ? ist(dd.at, false) : "", q.at ? ist(q.at, false) : "", q.reason || "", (q.flags || []).join("; ")]); }
  items.push({ action: "sheet", path: ["Leave & WFH"], name: `Requests ${yr}`, tabs: [{ name: "Requests", rows: req }] });
  // Travel claims this year
  const tr: any[][] = [["Code","Employee","Trip","Client","Start","End","Category","Estimate","Claim total","Submitted","Manager","Finance","Finance note","Paid in pay run"]];
  for (const id of Object.keys(roots)) for (const t of Object.values((roots[id].trips || {}) as Record<string, any>)) { if (!String(t.start || "").startsWith(yr)) continue;
    const dd = { ...((D[id] || {})["t_" + t.tid] || {}), ...((F[id] || {})["t_" + t.tid] || {}) };
    tr.push([code(id), nm(id), `${t.from} → ${t.to}`, t.client || "", t.start || "", t.end || "", t.cat || "", t.est || "", t.claim ? t.claim.total : "", t.claim && t.claim.at ? ist(t.claim.at, false) : "", (dd.mgr && dd.mgr.s) || "", (dd.fin && dd.fin.s) || "", (dd.fin && dd.fin.note) || "", dd.paidYM || ""]); }
  items.push({ action: "sheet", path: ["Travel & claims"], name: `Claims ${yr}`, tabs: [{ name: "Claims", rows: tr }] });
  // Hiring & exits registers
  items.push({ action: "sheet", path: ["Hiring"], name: "Candidates", tabs: [{ name: "Candidates", rows: [["Name","Email","Role","Company","Category","Monthly CTC","Joining","Stage","LOI","LOI accepted","Added"],
    ...cands.map(({ data: x }) => [x.name, x.email, x.role, x.company, x.etype, x.ctc || "", x.join || "", x.stage, x.loi ? x.loi.ref : "", x.loi && x.loi.acceptedAt ? ist(x.loi.acceptedAt, false) : "", x.createdAt ? ist(x.createdAt, false) : ""])] }] });
  items.push({ action: "sheet", path: ["Exits"], name: "Exit register", tabs: [{ name: "Exits", rows: [["Code","Employee","Stage","Resigned on","Notice (days)","Last working day","By","Reason","Handover submitted","Signed items","F&F net","F&F due","Paid on","Relieving letter"],
    ...exits.filter(x => x.path.split("/").length === 2).map(({ path, data: x }) => { const id = uidOf(path); return [code(id), nm(id), x.stage, x.resignedOn, x.notice, x.lwd, x.by, x.reason, x.handoverNote ? ist(x.handoverNote.at, false) : "", Object.values(x.handover || {}).filter((h: any) => h.ok).length + "/5", x.fnf ? x.fnf.net : "", x.fnf ? x.fnf.due : "", x.paidOn || "", x.relieving ? x.relieving.url : ""]; })] }] });
  const out = await gas({ action: "batch", items });
  const errs = (out.results || []).filter((x: any) => !x.ok).map((x: any) => x.error);
  await putDoc("drivelog/status", { at: nowMs(), ok: !errs.length, files: (out.results || []).length, errors: errs.slice(0, 5) });
  return { ok: !errs.length, files: (out.results || []).length, errors: errs.slice(0, 5) };
}

// =====================================================================================
Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  CFG = null;
  try {
    const b = await req.json().catch(() => ({}));
    const cron = req.headers.get("x-cron");
    if (cron) { need(safeEq(cron, (await cfg()).cron_secret || ""), "Forbidden", 403); if (b.op === "nightly") return json(await nightly()); throw new Fail("Unknown"); }
    if (b.op === "portal") return json(await opPortal(b));
    const c = await caller(req);
    switch (b.op) {
      case "ping": need(c.role === "owner", "Only the CEO.", 403); return json(await gas({ action: "ping" }));
      case "sync": need(c.role === "owner", "Only the CEO.", 403); return json(await nightly());
      case "push": return json(await opPush(c, b));
      case "upload": return json(await opUpload(c, b));
      case "cand_create": return json(await opCandCreate(c, b));
      case "loi_issue": return json(await opLoiIssue(c, b));
      case "join": return json(await opJoin(c, b));
      case "letter_issue": return json(await opLetterIssue(c, b));
      case "letter_accept": return json(await opLetterAccept(c, b));
      case "probation": return json(await opProbation(c, b));
      case "resign": return json(await opResign(c, b));
      case "handover": return json(await opHandoverSubmit(c, b));
      case "exit_sign": return json(await opExitSign(c, b));
      case "exit_lwd": return json(await opExitLwd(c, b));
      case "exit_start": return json(await opExitStart(c, b));
      case "exit_cancel": return json(await opExitCancel(c, b));
      case "fnf": return json(await opFnf(c, b));
      case "fnf_paid": return json(await opFnfPaid(c, b));
      default: throw new Fail("Unknown request.");
    }
  } catch (e) {
    const status = e instanceof Fail ? e.status : 500;
    if (!(e instanceof Fail)) console.error(e);
    return json({ ok: false, error: e instanceof Fail ? e.message : "Something went wrong on the server: " + String((e as Error)?.message || e).slice(0, 200) }, status);
  }
});
