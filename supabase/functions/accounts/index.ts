// Atraski People: logins created and reset by the CEO or the HR Coordinator.
// create_login: makes the account with the given email and password, already confirmed, and links it
//               to the person's pre-filled record through their joining code (the sign-up trigger does the linking).
// set_password: sets a new password for someone who already has a login.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class Fail extends Error { constructor(m: string, public status = 400) { super(m); } }
const need = (c: unknown, m: string, s = 400) => { if (!c) throw new Fail(m, s); };
const DEPT_ROLES = ["owner", "hr", "hr_team", "finance", "finance_team"];

async function caller(req: Request) {
  const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""); need(tok, "Sign in first.", 401);
  const { data, error } = await admin.auth.getUser(tok); need(!error && data && data.user, "Your session has ended. Sign in again.", 401);
  const { data: m } = await admin.from("members").select("role").eq("user_id", data!.user!.id).maybeSingle();
  const role = (m && m.role) || "pending";
  need(role === "owner" || role === "hr", "Only the CEO or the HR Coordinator can manage logins.", 403);
  return { uid: data!.user!.id, role };
}
async function rolesDoc() { const { data, error } = await admin.from("docs").select("data").eq("path", "config/roles").maybeSingle(); if (error) throw error; return (data && data.data) || { users: {} }; }
const okEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const okPassword = (p: string) => typeof p === "string" && p.length >= 8 && p.length <= 72;

async function createLogin(b: any) {
  const pre = String(b.pre || ""), email = String(b.email || "").trim().toLowerCase(), password = String(b.password || "");
  need(/^e_[a-z0-9_]{2,40}$/.test(pre), "Pick a person who hasn't signed up yet.");
  need(okEmail(email), "Enter a valid email address.");
  need(okPassword(password), "Use a password of at least 8 characters.");
  const users = (await rolesDoc()).users || {}, p = users[pre];
  need(p, "That person's record wasn't found. They may already have a login.", 404);
  need(!p.exited, "That person has left. Their record is read-only.");
  const { data: code, error: ce } = await admin.rpc("join_code_service", { p_pre: pre }); if (ce) throw ce;
  need(code, "Couldn't prepare a joining code for this person. Try again.");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: p.name || email.split("@")[0], join_code: code } });
  if (error) {
    if (/already|registered|exists/i.test(error.message)) throw new Fail("That email already has a login. Use a different email, or reset that login's password.", 409);
    throw new Fail(error.message);
  }
  const uid = data.user!.id;
  const { data: m } = await admin.from("members").select("role").eq("user_id", uid).maybeSingle();
  const linked = !!(m && m.role !== "pending");
  if (linked) {   // keep the record's work email in step with the login
    const doc = await rolesDoc(); if (doc.users && doc.users[uid]) { doc.users[uid].workEmail = email; await admin.from("docs").update({ data: doc }).eq("path", "config/roles"); }
  }
  return { ok: true, uid, email, linked, access: m ? m.role : "pending" };
}

async function setPassword(c: { uid: string; role: string }, b: any) {
  const uid = String(b.uid || ""), password = String(b.password || "");
  need(/^[0-9a-f-]{36}$/.test(uid), "Pick someone who already has a login.");
  need(okPassword(password), "Use a password of at least 8 characters.");
  const { data: m } = await admin.from("members").select("role,email").eq("user_id", uid).maybeSingle();
  need(m, "That login wasn't found.", 404);
  need(m!.role !== "owner" || uid === c.uid, "The CEO's password can only be changed by the CEO.", 403);
  need(c.role === "owner" || !DEPT_ROLES.includes(m!.role) || uid === c.uid, "Only the CEO can reset an HR or Finance login.", 403);
  const { error } = await admin.auth.admin.updateUserById(uid, { password }); if (error) throw new Fail(error.message);
  return { ok: true, email: m!.email };
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  try {
    const b = await req.json().catch(() => ({})), c = await caller(req);
    switch (b.op) {
      case "create_login": return json(await createLogin(b));
      case "set_password": return json(await setPassword(c, b));
      default: throw new Fail("Unknown action");
    }
  } catch (e) {
    const s = e instanceof Fail ? e.status : 500;
    return json({ ok: false, error: e instanceof Fail ? e.message : "Something went wrong. Try again." }, s);
  }
});
