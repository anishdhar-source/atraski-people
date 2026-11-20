/**
 * Atraski People → Google Drive bridge.
 * Runs under the CEO's own Google account, so everything it writes stays in that account's Drive and
 * every email goes out from that account's Gmail. The app's server sends it requests that carry SECRET.
 *
 * Set up (one time): script.new → paste this file → Deploy → New deployment → Web app →
 * Execute as: Me · Who has access: Anyone → Deploy → copy the /exec link into Atraski People.
 * The app fills in SECRET and ROOT for you on its "Google Drive" panel.
 */
const SECRET = '__SECRET__';
const ROOT = '__ROOT__';          // the private "Atraski People" folder
const MAX_ROWS = 20000;

function doGet() {
  return ContentService.createTextOutput('Atraski People Drive bridge is running.');
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!req.secret || req.secret !== SECRET) throw new Error('Not allowed');
    out = handle(req);
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  switch (req.action) {
    case 'ping': return { ok: true, folder: DriveApp.getFolderById(ROOT).getName(), url: DriveApp.getFolderById(ROOT).getUrl(), email: Session.getEffectiveUser().getEmail() };
    case 'sheet': return writeSheet(req);
    case 'file': return saveFile(req);
    case 'letter': return makeLetter(req);
    case 'mail': return sendMail(req);
    case 'batch': return { ok: true, results: (req.items || []).map(it => { try { return handle(it); } catch (err) { return { ok: false, error: String(err.message || err) }; } }) };
    default: throw new Error('Unknown action ' + req.action);
  }
}

// ---------- folders ----------
function clean(name) { return String(name || '').replace(/[\\/:*?"<>|#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled'; }
function folderAt(path) {
  let f = DriveApp.getFolderById(ROOT);
  (path || []).forEach(p => { const n = clean(p); const it = f.getFoldersByName(n); f = it.hasNext() ? it.next() : f.createFolder(n); });
  return f;
}
function replaceIn(folder, name) { const it = folder.getFilesByName(name); while (it.hasNext()) it.next().setTrashed(true); }

// ---------- sheets ----------
function safeCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;   // never let data become a formula
}
function writeSheet(req) {
  const folder = folderAt(req.path), name = clean(req.name);
  const it = folder.getFilesByName(name);
  let ss;
  if (it.hasNext()) ss = SpreadsheetApp.open(it.next());
  else { ss = SpreadsheetApp.create(name); DriveApp.getFileById(ss.getId()).moveTo(folder); }
  const tabs = req.tabs || [{ name: 'Sheet1', rows: req.rows || [] }];
  tabs.forEach((t, i) => {
    const tn = clean(t.name).slice(0, 90);
    let sh = ss.getSheetByName(tn);
    if (!sh) {
      const first = ss.getSheets()[0];
      sh = (i === 0 && ss.getSheets().length === 1 && first.getLastRow() === 0) ? first.setName(tn) : ss.insertSheet(tn);
    }
    sh.clearContents();
    const rows = (t.rows || []).slice(0, MAX_ROWS);
    if (!rows.length) return;
    const w = Math.max.apply(null, rows.map(r => r.length));
    const vals = rows.map(r => { const a = r.map(safeCell); while (a.length < w) a.push(''); return a; });
    sh.getRange(1, 1, vals.length, w).setValues(vals);
    sh.getRange(1, 1, 1, w).setFontWeight('bold').setBackground('#EEF1F7');
    sh.setFrozenRows(1);
  });
  return { ok: true, url: ss.getUrl(), id: ss.getId(), folderUrl: folder.getUrl() };
}

// ---------- uploaded files ----------
function saveFile(req) {
  const folder = folderAt(req.path), name = clean(req.name);
  replaceIn(folder, name);
  const blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.mime || 'application/octet-stream', name);
  const f = folder.createFile(blob);
  return { ok: true, url: f.getUrl(), id: f.getId(), folderUrl: folder.getUrl() };
}

// ---------- letters: Google Doc + PDF ----------
// req.blocks: [{t:'title'|'h'|'p'|'kv'|'sign'|'note', text, rows:[[k,v]]}]
function makeLetter(req) {
  const folder = folderAt(req.path), name = clean(req.name);
  const doc = DocumentApp.create(name);
  const body = doc.getBody();
  body.setMarginTop(54).setMarginBottom(54).setMarginLeft(60).setMarginRight(60);
  const head = body.getParagraphs()[0];
  head.setText('ATRASKI INDIA').setHeading(DocumentApp.ParagraphHeading.NORMAL).setBold(true).setFontSize(16).setForegroundColor('#0F1730');
  body.appendParagraph(req.company || 'Atraski India · At Buzz').setFontSize(9).setForegroundColor('#5D667C').setBold(false);
  body.appendHorizontalRule();
  (req.blocks || []).forEach(b => {
    if (b.t === 'title') body.appendParagraph(b.text).setHeading(DocumentApp.ParagraphHeading.HEADING2).setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    else if (b.t === 'h') body.appendParagraph(b.text).setHeading(DocumentApp.ParagraphHeading.HEADING4);
    else if (b.t === 'kv') {
      const t = body.appendTable((b.rows || []).map(r => [String(r[0]), String(r[1] == null ? '' : r[1])]));
      t.setBorderWidth(0.5).setBorderColor('#D7DCE6');
      for (let i = 0; i < t.getNumRows(); i++) { t.getCell(i, 0).setBackgroundColor('#F4F6FA').editAsText().setBold(true).setFontSize(10); t.getCell(i, 1).editAsText().setFontSize(10); }
    }
    else if (b.t === 'note') body.appendParagraph(b.text).setFontSize(9).setForegroundColor('#5D667C').setItalic(true);
    else if (b.t === 'sign') { body.appendParagraph(b.text).setBold(true).setForegroundColor('#0B7A5C'); }
    else body.appendParagraph(b.text || '').setFontSize(11).setBold(false).setItalic(false).setForegroundColor('#121A2F');
  });
  doc.saveAndClose();
  const docFile = DriveApp.getFileById(doc.getId());
  docFile.moveTo(folder);
  replaceIn(folder, name + '.pdf');
  const pdf = folder.createFile(docFile.getAs('application/pdf').setName(name + '.pdf'));
  if (!req.keepDoc) docFile.setTrashed(true);
  return { ok: true, url: pdf.getUrl(), id: pdf.getId(), docUrl: req.keepDoc ? docFile.getUrl() : '', folderUrl: folder.getUrl() };
}

// ---------- email from the CEO's Gmail ----------
function sendMail(req) {
  if (!req.to) throw new Error('No recipient');
  const opts = { name: req.fromName || 'Atraski People', htmlBody: req.html || undefined };
  if (req.cc) opts.cc = req.cc;
  if (req.replyTo) opts.replyTo = req.replyTo;
  if (req.attach && req.attach.length) opts.attachments = req.attach.map(id => DriveApp.getFileById(id).getBlob());
  MailApp.sendEmail(req.to, req.subject || 'Atraski People', req.text || '', opts);
  return { ok: true, left: MailApp.getRemainingDailyQuota() };
}
