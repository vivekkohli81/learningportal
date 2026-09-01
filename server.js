const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const writingSubmitHtml = fs.readFileSync(path.join(__dirname, 'writing-submit.html'), 'utf8');
let compPrepHtml = '';
try { compPrepHtml = fs.readFileSync(path.join(__dirname, 'comp-prep.html'), 'utf8'); } catch (e) { console.log('comp-prep.html not found yet'); }

// === PERSISTENT DATA STORAGE ===
// Use Railway volume if available, otherwise fall back to app directory
// Railway volumes persist across redeploys — set RAILWAY_VOLUME_MOUNT_PATH in Railway dashboard
const DATA_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
console.log('Data storage root:', DATA_ROOT);

// On first deploy, copy seed files from app dir to volume if they don't exist
function seedFile(filename, subdir) {
  const src = path.join(__dirname, subdir, filename);
  const dest = path.join(DATA_ROOT, subdir, filename);
  if (!fs.existsSync(dest) && fs.existsSync(src)) {
    fs.mkdirSync(path.join(DATA_ROOT, subdir), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log('Seeded', dest);
  }
}

// === VOLUME DETECTION ===
// If RAILWAY_VOLUME_MOUNT_PATH is not set, DATA_ROOT falls back to the app
// directory — which Railway REPLACES on every deploy. That means all student
// progress would be lost on each upgrade. We detect and loudly warn about it.
// === PORTAL URL ===
// Single source of truth for links in emails. Previously some emails
// pointed at an old GitHub Pages address, which sent the student to a
// stale copy of the portal. Override with PORTAL_URL if the address changes.
const PORTAL_URL = (process.env.PORTAL_URL || 'https://learningportal-production.up.railway.app/').replace(/\/?$/, '/');

// === EMAIL RECIPIENTS ===
// Overridable from Railway so addresses can change without a code edit.
// STUDENT_EMAIL can be pointed at the parent's inbox while the sending
// domain is unverified, since Resend's sandbox only reaches the account owner.
const PARENT_EMAIL = process.env.PARENT_EMAIL || 'vivekkohli81@gmail.com';
const STUDENT_EMAIL = process.env.STUDENT_EMAIL || 'kohliriyansh575@gmail.com';

const USING_VOLUME = !!process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (!USING_VOLUME) {
  console.warn('==========================================================');
  console.warn('WARNING: No persistent volume detected.');
  console.warn('Student progress will be LOST on the next deploy.');
  console.warn('Fix: in the Railway dashboard add a Volume, then set');
  console.warn('RAILWAY_VOLUME_MOUNT_PATH to its mount path (e.g. /data).');
  console.warn('==========================================================');
} else {
  console.log('Persistent volume active at:', process.env.RAILWAY_VOLUME_MOUNT_PATH);
}

// === BACKUPS ===
// Rolling snapshots so a bad merge, corrupted write, or accidental reset
// can always be rolled back. Backups live on the same volume as the data.
const BACKUP_DIR = path.join(DATA_ROOT, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Write a file safely: snapshot the previous version first, then write
// atomically via a temp file so a crash mid-write cannot corrupt the original.
function safeWriteJSON(filePath, data, backupLabel) {
  try {
    if (fs.existsSync(filePath)) {
      const label = backupLabel || path.basename(filePath, '.json');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupPath = path.join(BACKUP_DIR, label + '__' + stamp + '.json');
      // Only snapshot if we haven't already backed this file up in the last 10 min,
      // otherwise frequent syncs would flood the backup folder.
      if (!recentBackupExists(label, 10 * 60 * 1000)) {
        fs.copyFileSync(filePath, backupPath);
      }
    }
  } catch (e) {
    console.log('Backup step failed (continuing with write):', e.message);
  }

  // Atomic write
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);

  pruneBackups();
}

function recentBackupExists(label, windowMs) {
  try {
    const now = Date.now();
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(label + '__'))
      .some(f => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return (now - st.mtimeMs) < windowMs;
      });
  } catch (e) { return false; }
}

// Keep the 40 most recent backups per label, plus never delete the oldest
// one for each calendar day (so long-term history survives).
function pruneBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json'));
    const byLabel = {};
    files.forEach(f => {
      const label = f.split('__')[0];
      (byLabel[label] = byLabel[label] || []).push(f);
    });
    Object.keys(byLabel).forEach(label => {
      const list = byLabel[label]
        .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      const keepDaily = new Set();
      list.forEach(x => {
        const day = new Date(x.t).toISOString().slice(0, 10);
        if (!keepDaily.has(day)) keepDaily.add(day), (x.keepDaily = true);
      });
      list.slice(40).forEach(x => {
        if (x.keepDaily) return;
        try { fs.unlinkSync(path.join(BACKUP_DIR, x.f)); } catch (e) {}
      });
    });
  } catch (e) {}
}

// === PERFORMANCE DATABASE ===
const PERF_DIR = path.join(DATA_ROOT, 'data');
if (!fs.existsSync(PERF_DIR)) fs.mkdirSync(PERF_DIR, { recursive: true });

// === QUIZ RESULTS DATABASE ===
const QUIZ_DIR = path.join(DATA_ROOT, 'quiz-results');
if (!fs.existsSync(QUIZ_DIR)) fs.mkdirSync(QUIZ_DIR, { recursive: true });

// === WRITING SUBMISSIONS DATABASE ===
const WRITING_DIR = path.join(DATA_ROOT, 'writing-submissions');
if (!fs.existsSync(WRITING_DIR)) fs.mkdirSync(WRITING_DIR, { recursive: true });

// === HOMEWORK SUBMISSIONS DATABASE ===
const HOMEWORK_DIR = path.join(DATA_ROOT, 'homework');
if (!fs.existsSync(HOMEWORK_DIR)) fs.mkdirSync(HOMEWORK_DIR, { recursive: true });
const HOMEWORK_FILES_DIR = path.join(HOMEWORK_DIR, 'files');
if (!fs.existsSync(HOMEWORK_FILES_DIR)) fs.mkdirSync(HOMEWORK_FILES_DIR, { recursive: true });

function getHomeworkPath(username) {
  const safe = username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  return path.join(HOMEWORK_DIR, safe + '.json');
}

function readHomework(username) {
  const fp = getHomeworkPath(username);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {}
  return { username, submissions: [] };
}

function saveHomework(username, data) {
  const fp = getHomeworkPath(username);
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
}

// Parse multipart form data (for file uploads)
function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  let pos = 0;

  while (pos < buffer.length) {
    const boundaryStart = buffer.indexOf(boundaryBuf, pos);
    if (boundaryStart === -1) break;

    const nextBoundary = buffer.indexOf(boundaryBuf, boundaryStart + boundaryBuf.length + 2);
    if (nextBoundary === -1) break;

    const partData = buffer.slice(boundaryStart + boundaryBuf.length + 2, nextBoundary - 2);
    const headerEnd = partData.indexOf('\r\n\r\n');
    if (headerEnd === -1) { pos = nextBoundary; continue; }

    const headers = partData.slice(0, headerEnd).toString('utf8');
    const body = partData.slice(headerEnd + 4);

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const contentTypeMatch = headers.match(/Content-Type:\s*(.+)/i);

    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: contentTypeMatch ? contentTypeMatch[1].trim() : null,
      data: body
    });

    pos = nextBoundary;
  }
  return parts;
}

// Read raw body as Buffer (for multipart)
function readBodyRaw(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getQuizResultsPath(username) {
  const safe = username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  return path.join(QUIZ_DIR, safe + '.json');
}

function readQuizResults(username) {
  const fp = getQuizResultsPath(username);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {}
  return { username, quizzes: [] };
}

function saveQuizResult(username, result) {
  const data = readQuizResults(username);
  data.quizzes.push(result);
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(getQuizResultsPath(username), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

// === COMPETITION PREP ASSIGNMENTS DATABASE ===
// === ASSIGNMENTS LIBRARY ===
// Every assignment the scheduler generates is stored here so the portal can
// list it and the student can open it later. Previously writing, science and
// coding assignments existed only inside an email — if the email was missed
// or unreachable, the work was simply gone.
const ASSIGNMENTS_DIR = path.join(DATA_ROOT, 'assignments');
if (!fs.existsSync(ASSIGNMENTS_DIR)) fs.mkdirSync(ASSIGNMENTS_DIR, { recursive: true });

function recordAssignment(rec) {
  try {
    const date = rec.date || new Date().toISOString().slice(0, 10);
    const id = rec.id || (rec.subject + '-' + date + '-' + Date.now());
    const full = {
      id: id,
      subject: rec.subject,
      title: rec.title || rec.subject,
      date: date,
      createdAt: new Date().toISOString(),
      level: rec.level || null,
      // The full HTML body — same content the email shows, so the portal
      // renders the real prompts, questions, diagrams and links.
      html: rec.html || '',
      externalUrl: rec.externalUrl || null,
      answerMode: rec.answerMode || 'text',
      status: 'pending',
      submission: null
    };
    fs.writeFileSync(path.join(ASSIGNMENTS_DIR, id + '.json'), JSON.stringify(full, null, 2), 'utf8');
    console.log('[Assignments] Stored', id);
    return full;
  } catch (e) {
    console.error('[Assignments] Could not store assignment:', e.message);
    return null;
  }
}

function listAssignments() {
  try {
    return fs.readdirSync(ASSIGNMENTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(ASSIGNMENTS_DIR, f), 'utf8')); }
        catch (e) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  } catch (e) { return []; }
}

function getAssignment(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  const fp = path.join(ASSIGNMENTS_DIR, safe + '.json');
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {}
  return null;
}

function saveAssignmentRecord(rec) {
  const safe = String(rec.id).replace(/[^a-zA-Z0-9_-]/g, '');
  safeWriteJSON(path.join(ASSIGNMENTS_DIR, safe + '.json'), rec, 'assignment-' + safe);
}

// Feeds a marked assignment back into the student's progress so the NEXT
// assignment adapts. Without this, work submitted through the portal is
// stored but never influences difficulty — the loop stays open.
//
// Uses the same rules as the portal quizzes: 80%+ moves the level up,
// under 40% moves it down, levels clamp to 1..5.
function applyAssignmentToProgress(username, subject, score) {
  if (score == null || !subject) return null;
  const topicFor = { english: 'writing', science: 'biology', maths: 'problemSolving' };
  const topic = topicFor[subject];
  if (!topic) return null;   // coding has no graded topic

  try {
    const fp = getSyncPath(username);
    if (!fs.existsSync(fp)) return null;
    const rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!rec || !rec.progress) return null;

    const p = rec.progress;
    if (!p[subject]) p[subject] = {};
    if (!p[subject][topic]) p[subject][topic] = { lv: 1, ok: 0, no: 0, h: [], sn: [], mk: [] };
    const t = p[subject][topic];

    // Treat the assignment as 10 questions so it carries sensible weight
    const correct = Math.round((score / 100) * 10);
    t.ok = (t.ok || 0) + correct;
    t.no = (t.no || 0) + (10 - correct);
    t.h = t.h || [];
    t.h.push({ date: new Date().toDateString(), score: correct, total: 10, pct: score });

    const before = t.lv || 1;
    if (score >= 80 && t.lv < 5) t.lv = (t.lv || 1) + 1;
    else if (score < 40 && t.lv > 1) t.lv = (t.lv || 1) - 1;

    p.total = (p.total || 0) + 1;
    p.done = p.done || [];
    p.done.push({ date: new Date().toDateString(), subject: subject, topic: topic, score: score + '%' });

    rec.progress = p;
    rec.lastSyncDate = new Date().toISOString();
    safeWriteJSON(fp, rec, 'sync-' + String(username).replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase());

    console.log('[Assignments] ' + subject + '/' + topic + ' level ' + before + ' -> ' + t.lv + ' (scored ' + score + '%)');
    return { subject, topic, levelBefore: before, levelAfter: t.lv, score };
  } catch (e) {
    console.error('[Assignments] Could not apply score to progress:', e.message);
    return null;
  }
}

const COMP_PREP_DIR = path.join(DATA_ROOT, 'comp-prep');
if (!fs.existsSync(COMP_PREP_DIR)) fs.mkdirSync(COMP_PREP_DIR, { recursive: true });
const COMP_PREP_FILES_DIR = path.join(COMP_PREP_DIR, 'uploads');
if (!fs.existsSync(COMP_PREP_FILES_DIR)) fs.mkdirSync(COMP_PREP_FILES_DIR, { recursive: true });

// === FULL PROGRESS SYNC DATABASE ===
const SYNC_DIR = path.join(DATA_ROOT, 'sync');
if (!fs.existsSync(SYNC_DIR)) fs.mkdirSync(SYNC_DIR, { recursive: true });

// === ACCOUNTS DATABASE ===
const ACCOUNTS_FILE = path.join(DATA_ROOT, 'sync', 'accounts.json');

// Seed the default accounts file on first deploy to volume
seedFile('accounts.json', 'sync');

function readAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch (e) {}
  return null;
}

function writeAccounts(data) {
  data.lastUpdated = new Date().toISOString();
  // Backed-up atomic write — losing this file would lock everyone out
  safeWriteJSON(ACCOUNTS_FILE, data, 'accounts');
}

function getSyncPath(username) {
  const safe = username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  return path.join(SYNC_DIR, safe + '.json');
}

// === SERVER-SIDE PROGRESS MERGE ===
// Critical for cross-device safety. Without this, a device holding stale data
// would overwrite newer progress made on another device. We never discard
// work: for every field we keep the most complete version we have seen.
function mergeTopic(stored, incoming) {
  if (!stored) return incoming;
  if (!incoming) return stored;
  const out = Object.assign({}, stored);

  // Attempt counts: take the more advanced record. Work is only ever added,
  // never undone, so a lower total means that device is stale.
  // On a tie, prefer the record with more correct answers so a stale device
  // can never downgrade the student's accuracy.
  const storedTotal = (stored.ok || 0) + (stored.no || 0);
  const incomingTotal = (incoming.ok || 0) + (incoming.no || 0);
  if (incomingTotal > storedTotal ||
      (incomingTotal === storedTotal && (incoming.ok || 0) > (stored.ok || 0))) {
    out.ok = incoming.ok || 0;
    out.no = incoming.no || 0;
  }

  // Difficulty level: keep the highest reached
  out.lv = Math.max(stored.lv || 1, incoming.lv || 1);

  // Quiz history: union, deduplicated by date + score + total
  const hist = (stored.h || []).slice();
  const seenH = new Set(hist.map(h => h.date + '|' + h.score + '|' + h.total));
  (incoming.h || []).forEach(h => {
    const k = h.date + '|' + h.score + '|' + h.total;
    if (!seenH.has(k)) { hist.push(h); seenH.add(k); }
  });
  out.h = hist;

  // Seen question IDs: union so a question is never served twice
  const seenIds = new Set([...(stored.sn || []), ...(incoming.sn || [])]);
  out.sn = Array.from(seenIds);

  // Mistake history: union deduplicated by question text, newest 20 kept.
  // This is what powers adaptive question generation.
  const mistakes = (stored.mk || []).slice();
  const seenM = new Set(mistakes.map(m => (m.q || '') + '|' + (m.date || '')));
  (incoming.mk || []).forEach(m => {
    const k = (m.q || '') + '|' + (m.date || '');
    if (!seenM.has(k)) { mistakes.push(m); seenM.add(k); }
  });
  out.mk = mistakes.slice(-20);

  return out;
}

function mergeProgress(stored, incoming) {
  if (!stored) return incoming;
  if (!incoming) return stored;
  const out = JSON.parse(JSON.stringify(stored));

  ['english', 'maths', 'science', 'ib7'].forEach(subj => {
    if (!incoming[subj]) return;
    if (!out[subj]) out[subj] = {};
    Object.keys(incoming[subj]).forEach(topic => {
      out[subj][topic] = mergeTopic(out[subj][topic], incoming[subj][topic]);
    });
  });

  // Competition prep topics
  if (incoming.comp) {
    if (!out.comp) out.comp = {};
    Object.keys(incoming.comp).forEach(t => {
      out.comp[t] = mergeTopic(out.comp[t], incoming.comp[t]);
    });
  }

  // Writings: union by date + title so nothing the student wrote is lost
  const writings = (stored.wr || []).slice();
  const seenW = new Set(writings.map(w => (w.date || '') + '|' + (w.title || '')));
  (incoming.wr || []).forEach(w => {
    const k = (w.date || '') + '|' + (w.title || '');
    if (!seenW.has(k)) { writings.push(w); seenW.add(k); }
  });
  out.wr = writings;

  // Completed activity log: union by date + subject + topic + score
  const done = (stored.done || []).slice();
  const seenD = new Set(done.map(d => (d.date || '') + '|' + (d.subject || '') + '|' + (d.topic || '') + '|' + (d.score || '')));
  (incoming.done || []).forEach(d => {
    const k = (d.date || '') + '|' + (d.subject || '') + '|' + (d.topic || '') + '|' + (d.score || '');
    if (!seenD.has(k)) { done.push(d); seenD.add(k); }
  });
  out.done = done;

  // Active days: union, so streaks stay accurate across devices
  const days = new Set([...(stored.activeDays || []), ...(incoming.activeDays || [])]);
  out.activeDays = Array.from(days);

  // Scalar counters: keep the maximum
  out.total = Math.max(stored.total || 0, incoming.total || 0);
  out.streak = Math.max(stored.streak || 0, incoming.streak || 0);

  // AI-generated question cache: union by key
  out.aiQ = Object.assign({}, stored.aiQ || {}, incoming.aiQ || {});

  // Assignments: union by id. If the same paper exists on both sides, keep the
  // more advanced copy — a marked paper always beats an in-progress one, and
  // otherwise the version with more answers filled in wins.
  const asgById = {};
  (stored.assignments || []).forEach(a => { if (a && a.id) asgById[a.id] = a; });
  (incoming.assignments || []).forEach(a => {
    if (!a || !a.id) return;
    const prev = asgById[a.id];
    if (!prev) { asgById[a.id] = a; return; }
    const rank = x => (x.status === 'marked' ? 2 : x.status === 'submitted' ? 1 : 0);
    if (rank(a) > rank(prev)) { asgById[a.id] = a; return; }
    if (rank(a) === rank(prev)) {
      const na = Object.keys(a.answers || {}).length;
      const np = Object.keys(prev.answers || {}).length;
      if (na > np) asgById[a.id] = a;
    }
  });
  out.assignments = Object.keys(asgById).map(k => asgById[k]).slice(-30);

  return out;
}

function getPerfPath(username) {
  const safe = username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  return path.join(PERF_DIR, safe + '.json');
}

function readPerf(username) {
  const fp = getPerfPath(username);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {}
  return null;
}

function writePerf(username, data) {
  const fp = getPerfPath(username);
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
}

function listAllPerf() {
  try {
    const files = fs.readdirSync(PERF_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PERF_DIR, f), 'utf8'));
        return data;
      } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function proxyRequest(options, body, res) {
  const proxyReq = https.request(options, (proxyRes) => {
    let chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      const responseBody = Buffer.concat(chunks).toString();
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(responseBody);
    });
  });
  proxyReq.on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }));
  });
  proxyReq.write(body);
  proxyReq.end();
}

const server = http.createServer(async (req, res) => {
  // Path without any query string. Routes below that match an exact path use
  // this, so adding "?t=1" (e.g. to bypass browser caching) still works
  // instead of falling through to the static file handler.
  const pathOnly = (req.url || '').split('?')[0];

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version'
    });
    res.end();
    return;
  }

  // === HEALTH / DATA SAFETY CHECK ===
  // Open this in a browser to confirm data will survive the next deploy.
  if (pathOnly === '/api/health' && req.method === 'GET') {
    const info = {
      status: 'ok',
      serverTime: new Date().toISOString(),
      persistentVolume: {
        active: USING_VOLUME,
        mountPath: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
        dataRoot: DATA_ROOT,
        verdict: USING_VOLUME
          ? 'SAFE - student data is stored on a persistent volume and will survive deploys.'
          : 'AT RISK - no volume detected. Data is in the app directory and WILL BE LOST on the next deploy. Add a Volume in Railway and set RAILWAY_VOLUME_MOUNT_PATH.'
      },
      stored: {},
      backups: {}
    };

    function summarise(dir, label) {
      try {
        if (!fs.existsSync(dir)) return { files: 0 };
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        let newest = null;
        files.forEach(f => {
          const st = fs.statSync(path.join(dir, f));
          if (!newest || st.mtimeMs > newest) newest = st.mtimeMs;
        });
        return {
          files: files.length,
          names: files.slice(0, 10),
          lastModified: newest ? new Date(newest).toISOString() : null
        };
      } catch (e) { return { error: e.message }; }
    }

    info.stored.progressSync = summarise(SYNC_DIR);
    info.stored.performance = summarise(PERF_DIR);
    info.stored.quizResults = summarise(QUIZ_DIR);
    info.stored.writing = summarise(WRITING_DIR);
    info.stored.homework = summarise(HOMEWORK_DIR);
    info.backups = summarise(BACKUP_DIR);

    // Warn if the seed template is the only thing present
    info.accountsFileExists = fs.existsSync(ACCOUNTS_FILE);

    // Never cache — this must always reflect the live server state
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    });
    res.end(JSON.stringify(info, null, 2));
    return;
  }

  // === FULL BACKUP EXPORT ===
  // Downloads every piece of student data as a single JSON file.
  if (pathOnly === '/api/backup' && req.method === 'GET') {
    try {
      const bundle = {
        exportedAt: new Date().toISOString(),
        version: 1,
        accounts: readAccounts(),
        sync: {},
        performance: {},
        quizResults: {},
        writing: {},
        homework: {}
      };
      function loadDir(dir, target) {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => {
          if (f === 'accounts.json') return;
          try { target[f.replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) {}
        });
      }
      loadDir(SYNC_DIR, bundle.sync);
      loadDir(PERF_DIR, bundle.performance);
      loadDir(QUIZ_DIR, bundle.quizResults);
      loadDir(WRITING_DIR, bundle.writing);
      loadDir(HOMEWORK_DIR, bundle.homework);

      const fname = 'riyansh-portal-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="' + fname + '"',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(bundle, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // === RESTORE FROM BACKUP ===
  // Merges an exported bundle back in. Uses the same union merge as normal
  // sync, so restoring can only ever add data back — never remove newer work.
  if (pathOnly === '/api/restore' && req.method === 'POST') {
    try {
      const bundle = JSON.parse(await readBody(req));
      if (!bundle || bundle.version !== 1) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Unrecognised backup file' }));
        return;
      }
      const restored = [];
      Object.keys(bundle.sync || {}).forEach(user => {
        const incoming = bundle.sync[user];
        if (!incoming || !incoming.progress) return;
        const fp = getSyncPath(user);
        let existing = null;
        try { if (fs.existsSync(fp)) existing = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {}
        const mergedProg = existing && existing.progress
          ? mergeProgress(existing.progress, incoming.progress)
          : incoming.progress;
        safeWriteJSON(fp, {
          username: user,
          name: incoming.name || user,
          progress: mergedProg,
          lastSyncDate: new Date().toISOString(),
          lastDevice: 'restore'
        }, 'sync-' + user);
        restored.push(user);
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, restored: restored }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Proxy Claude API calls
  if (req.url === '/api/claude' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const apiKey = req.headers['x-api-key'];
      proxyRequest({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        }
      }, body, res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
    return;
  }

  // Proxy Gemini API calls
  if (req.url.startsWith('/api/gemini') && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const geminiUrl = new URL(req.url, 'http://localhost').searchParams.get('url');
      if (!geminiUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Missing Gemini URL' } }));
        return;
      }
      const parsed = new URL(geminiUrl);
      proxyRequest({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, body, res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
    return;
  }

  // === QUIZ RESULTS API ===

  if (req.url === '/api/quiz-results' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.username) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'username is required' }));
        return;
      }
      const result = {
        quizId: body.quizId || 'quiz-' + new Date().toISOString().slice(0, 10),
        date: new Date().toISOString(),
        score: body.score,
        total: body.total,
        percentage: body.total > 0 ? Math.round((body.score / body.total) * 100) : 0,
        timeTaken: body.timeTaken || null,
        questions: body.questions || [],
        topics: body.topics || [],
        weakAreas: body.weakAreas || []
      };
      const data = saveQuizResult(body.username, result);

      const perf = readPerf(body.username) || { username: body.username };
      if (!perf.quizHistory) perf.quizHistory = [];
      perf.quizHistory.push({
        quizId: result.quizId,
        date: result.date,
        score: result.score,
        total: result.total,
        percentage: result.percentage,
        weakAreas: result.weakAreas
      });
      perf.lastQuizDate = result.date;
      perf.lastQuizScore = result.score + '/' + result.total;
      writePerf(body.username, perf);

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, quizId: result.quizId, totalQuizzes: data.quizzes.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith('/api/quiz-results/') && req.method === 'GET') {
    const username = decodeURIComponent(req.url.split('/api/quiz-results/')[1]).split('?')[0];
    const data = readQuizResults(username);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
    return;
  }

  // === ACCOUNTS SYNC API ===

  if (req.url === '/api/accounts' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      writeAccounts(body);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, kids: (body.kids || []).length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/api/accounts' && req.method === 'GET') {
    const data = readAccounts();
    if (data) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No accounts synced yet' }));
    }
    return;
  }

  // === FULL PROGRESS SYNC API ===

  if (req.url === '/api/sync' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.username) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'username is required' }));
        return;
      }
      const fp = getSyncPath(body.username);

      // Merge with whatever is already stored rather than overwriting.
      // Protects against a device with stale data wiping newer progress.
      let existing = null;
      try {
        if (fs.existsSync(fp)) existing = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch (e) {
        console.log('Could not read existing sync file, treating as new:', e.message);
      }

      let finalProgress = body.progress;
      let didMerge = false;
      if (existing && existing.progress && body.progress) {
        finalProgress = mergeProgress(existing.progress, body.progress);
        didMerge = true;
      }

      const record = {
        username: body.username,
        name: body.name || (existing && existing.name) || body.username,
        progress: finalProgress,
        syncTimestamp: body.syncTimestamp || Date.now(),
        lastSyncDate: new Date().toISOString(),
        lastDevice: body.device || 'unknown'
      };

      safeWriteJSON(fp, record, 'sync-' + body.username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase());
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, username: body.username, merged: didMerge, lastSyncDate: record.lastSyncDate, progress: finalProgress }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith('/api/sync/') && req.method === 'GET') {
    const username = decodeURIComponent(req.url.split('/api/sync/')[1]).split('?')[0];
    const fp = getSyncPath(username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase());
    try {
      if (fs.existsSync(fp)) {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(data));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'No sync data found', username: username }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // === PERFORMANCE API ===

  if (req.url === '/api/performance' && req.method === 'GET') {
    const all = listAllPerf();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(all));
    return;
  }

  if (req.url.startsWith('/api/performance/') && req.method === 'GET') {
    const username = decodeURIComponent(req.url.split('/api/performance/')[1]).split('?')[0];
    const data = readPerf(username);
    if (data) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Student not found', username: username }));
    }
    return;
  }

  if (req.url === '/api/performance' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.username) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'username is required' }));
        return;
      }
      writePerf(body.username, body);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, username: body.username }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // === HOMEWORK SUBMISSION API ===

  // POST /api/homework - submit homework with file upload (multipart/form-data)
  if (req.url === '/api/homework' && req.method === 'POST') {
    try {
      const contentType = req.headers['content-type'] || '';

      if (contentType.includes('multipart/form-data')) {
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'Missing boundary in multipart' }));
          return;
        }
        const rawBody = await readBodyRaw(req);
        const parts = parseMultipart(rawBody, boundary);

        let username = '', subject = '', topic = '', title = '', notes = '', fileData = null, fileName = '', fileType = '';

        parts.forEach(p => {
          if (p.name === 'username') username = p.data.toString('utf8').trim();
          else if (p.name === 'subject') subject = p.data.toString('utf8').trim();
          else if (p.name === 'topic') topic = p.data.toString('utf8').trim();
          else if (p.name === 'title') title = p.data.toString('utf8').trim();
          else if (p.name === 'notes') notes = p.data.toString('utf8').trim();
          else if (p.name === 'file' && p.filename) {
            fileData = p.data;
            fileName = p.filename;
            fileType = p.contentType || 'application/octet-stream';
          }
        });

        if (!username) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'username is required' }));
          return;
        }

        // Save file if present
        let savedFileName = null;
        if (fileData && fileName) {
          const safe = username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
          const ext = path.extname(fileName) || '.bin';
          savedFileName = safe + '_' + Date.now() + ext;
          fs.writeFileSync(path.join(HOMEWORK_FILES_DIR, savedFileName), fileData);
        }

        const submission = {
          id: 'hw_' + Date.now(),
          date: new Date().toISOString(),
          subject: subject || 'general',
          topic: topic || '',
          title: title || fileName || 'Untitled',
          notes: notes || '',
          fileName: fileName || null,
          savedFileName: savedFileName,
          fileType: fileType || null,
          fileSize: fileData ? fileData.length : 0,
          status: 'submitted',
          feedback: null
        };

        const data = readHomework(username);
        data.submissions.push(submission);
        saveHomework(username, data);

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, submissionId: submission.id, fileName: savedFileName }));
      } else {
        // JSON body (for submissions without file, e.g. text-only or base64)
        const body = JSON.parse(await readBody(req));
        if (!body.username) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'username is required' }));
          return;
        }

        let savedFileName = null;
        if (body.fileData && body.fileName) {
          const safe = body.username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
          const ext = path.extname(body.fileName) || '.bin';
          savedFileName = safe + '_' + Date.now() + ext;
          const base64Data = body.fileData.replace(/^data:[^;]+;base64,/, '');
          fs.writeFileSync(path.join(HOMEWORK_FILES_DIR, savedFileName), Buffer.from(base64Data, 'base64'));
        }

        const submission = {
          id: 'hw_' + Date.now(),
          date: new Date().toISOString(),
          subject: body.subject || 'general',
          topic: body.topic || '',
          title: body.title || body.fileName || 'Untitled',
          notes: body.notes || '',
          fileName: body.fileName || null,
          savedFileName: savedFileName,
          fileType: body.fileType || null,
          fileSize: body.fileSize || 0,
          status: 'submitted',
          feedback: body.feedback || null
        };

        const data = readHomework(body.username);
        data.submissions.push(submission);
        saveHomework(body.username, data);

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, submissionId: submission.id }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/homework/:username - get all homework submissions
  if (req.url.startsWith('/api/homework/') && req.method === 'GET') {
    const username = decodeURIComponent(req.url.split('/api/homework/')[1]).split('?')[0];
    const data = readHomework(username);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
    return;
  }

  // Serve uploaded homework files
  if (req.url.startsWith('/api/homework-file/') && req.method === 'GET') {
    const fileName = decodeURIComponent(req.url.split('/api/homework-file/')[1]).split('?')[0];
    const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '');
    const filePath = path.join(HOMEWORK_FILES_DIR, safeName);
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(safeName).toLowerCase();
        const mimeTypes = {'.pdf':'application/pdf','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.txt':'text/plain','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] || 'application/octet-stream',
          'Content-Disposition': 'inline; filename="' + safeName + '"',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'File not found' }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

// === WRITING SUBMISSION API ===

  if (req.url === '/api/writing-submit' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.username) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'username is required' }));
        return;
      }
      const safe = body.username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
      const fp = path.join(WRITING_DIR, safe + '.json');
      let data = { username: body.username, submissions: [] };
      try {
        if (fs.existsSync(fp)) data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch (e) {}

      let photoPath = null;
      if (body.photoData) {
        const photoDir = path.join(WRITING_DIR, 'photos');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        const photoName = safe + '_' + Date.now() + '.jpg';
        photoPath = path.join(photoDir, photoName);
        const base64Data = body.photoData.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(photoPath, Buffer.from(base64Data, 'base64'));
        body.photoData = null;
        body.photoSavedAs = photoName;
      }

      const submission = {
        id: 'wr_' + Date.now(),
        date: body.date || new Date().toISOString(),
        prompt: body.prompt || '',
        promptTitle: body.promptTitle || '',
        writingText: body.writingText || null,
        wordCount: body.wordCount || 0,
        hasPhoto: body.hasPhoto || false,
        photoFilename: body.photoFilename || null,
        photoSavedAs: body.photoSavedAs || null,
        checklist: body.checklist || [],
        feedback: body.feedback || null
      };

      data.submissions.push(submission);
      data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');

      const perf = readPerf(safe) || { username: body.username };
      if (!perf.writingHistory) perf.writingHistory = [];
      perf.writingHistory.push({
        id: submission.id,
        date: submission.date,
        promptTitle: submission.promptTitle,
        wordCount: submission.wordCount,
        checklistComplete: (submission.checklist || []).filter(function(c) { return c.checked; }).length + '/' + (submission.checklist || []).length
      });
      perf.lastWritingDate = submission.date;
      perf.totalWritings = (perf.totalWritings || 0) + 1;
      writePerf(safe, perf);

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, submissionId: submission.id, totalSubmissions: data.submissions.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith('/api/writing-submissions/') && req.method === 'GET') {
    const username = decodeURIComponent(req.url.split('/api/writing-submissions/')[1]).split('?')[0];
    const safe = username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    const fp = path.join(WRITING_DIR, safe + '.json');
    try {
      if (fs.existsSync(fp)) {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(data));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ username: username, submissions: [] }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // === COMPETITION PREP ASSIGNMENT API ===

  // POST /api/comp-prep — create a new competition prep assignment (called by scheduled task)
  if (pathOnly === '/api/comp-prep' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.username || !body.questions || !Array.isArray(body.questions)) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'username and questions[] are required' }));
        return;
      }
      const id = 'cp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const assignment = {
        id: id,
        username: body.username,
        date: body.date || new Date().toISOString().slice(0, 10),
        title: body.title || 'Maths Competition Prep',
        questions: body.questions, // each: {n, text, topic, difficulty, answer, solution}
        status: 'pending',         // pending → submitted → marked
        answers: {},               // student's typed answers keyed by question number
        uploadedFile: null,        // filename if student uploaded work
        result: null,              // marking result after submission
        createdAt: new Date().toISOString()
      };
      const fp = path.join(COMP_PREP_DIR, id + '.json');
      fs.writeFileSync(fp, JSON.stringify(assignment, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, id: id, url: '/comp-prep/' + id }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/comp-prep/:id — fetch assignment (hides solutions if not yet submitted)
  if (req.url.match(/^\/api\/comp-prep\/cp_[^/]+$/) && req.method === 'GET') {
    const id = decodeURIComponent(pathOnly.split('/api/comp-prep/')[1]);
    const fp = path.join(COMP_PREP_DIR, id + '.json');
    try {
      if (!fs.existsSync(fp)) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Assignment not found' }));
        return;
      }
      const asg = JSON.parse(fs.readFileSync(fp, 'utf8'));
      // Strip solutions and answers if student hasn't submitted yet
      if (asg.status === 'pending') {
        asg.questions = asg.questions.map(q => ({
          n: q.n, text: q.text, topic: q.topic, difficulty: q.difficulty
          // answer and solution are omitted
        }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(asg));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/comp-prep/list/:username — list all assignments for a student
  if (req.url.match(/^\/api\/comp-prep\/list\//) && req.method === 'GET') {
    const username = decodeURIComponent(pathOnly.split('/api/comp-prep/list/')[1]);
    try {
      const files = fs.readdirSync(COMP_PREP_DIR).filter(f => f.startsWith('cp_') && f.endsWith('.json'));
      const list = [];
      files.forEach(f => {
        try {
          const asg = JSON.parse(fs.readFileSync(path.join(COMP_PREP_DIR, f), 'utf8'));
          if (asg.username === username) {
            list.push({ id: asg.id, date: asg.date, title: asg.title, status: asg.status,
              score: asg.result ? asg.result.score : null,
              total: asg.result ? asg.result.total : null });
          }
        } catch (e) {}
      });
      list.sort((a, b) => b.date.localeCompare(a.date));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ username, assignments: list }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/comp-prep/:id/submit — submit answers (JSON with typed answers)
  if (req.url.match(/^\/api\/comp-prep\/cp_[^/]+\/submit$/) && req.method === 'POST') {
    const id = pathOnly.split('/api/comp-prep/')[1].replace('/submit', '');
    const fp = path.join(COMP_PREP_DIR, id + '.json');
    try {
      if (!fs.existsSync(fp)) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Assignment not found' }));
        return;
      }
      const asg = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const contentType = req.headers['content-type'] || '';

      if (contentType.includes('multipart/form-data')) {
        // File upload submission
        const boundary = contentType.split('boundary=')[1];
        const rawBody = await readBodyRaw(req);
        const parts = parseMultipart(rawBody, boundary);
        let answers = {};
        parts.forEach(p => {
          if (p.name === 'answers') {
            try { answers = JSON.parse(p.data.toString('utf8')); } catch (e) {}
          }
          if (p.name === 'file' && p.filename) {
            const ext = path.extname(p.filename) || '.bin';
            const savedName = id + '_upload' + ext;
            fs.writeFileSync(path.join(COMP_PREP_FILES_DIR, savedName), p.data);
            asg.uploadedFile = savedName;
            asg.uploadedOriginalName = p.filename;
          }
        });
        Object.assign(asg.answers, answers);
      } else {
        // JSON submission
        const body = JSON.parse(await readBody(req));
        if (body.answers) Object.assign(asg.answers, body.answers);
      }

      // Auto-mark: compare typed answers to correct answers
      let score = 0;
      let total = asg.questions.length;
      const details = [];
      asg.questions.forEach(q => {
        const studentAns = String(asg.answers[q.n] || '').trim();
        const correctAns = String(q.answer || '').trim();
        // Normalise both for comparison (case-insensitive, strip whitespace)
        const isCorrect = studentAns !== '' && studentAns.toLowerCase() === correctAns.toLowerCase();
        if (isCorrect) score++;
        details.push({
          n: q.n, studentAnswer: studentAns, correctAnswer: correctAns,
          correct: isCorrect, solution: q.solution
        });
      });

      asg.result = { score, total, percentage: Math.round((score / total) * 100), details };
      asg.status = asg.uploadedFile ? 'submitted' : 'marked';
      asg.submittedAt = new Date().toISOString();

      // If only uploaded file (no typed answers), mark as submitted for manual review
      const hasTypedAnswers = Object.keys(asg.answers).length > 0;
      if (hasTypedAnswers) asg.status = 'marked';

      fs.writeFileSync(fp, JSON.stringify(asg, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, status: asg.status, result: asg.result, questions: asg.questions }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve competition prep page: /comp-prep/:id
  if (req.url.match(/^\/comp-prep\/cp_/)) {
    if (compPrepHtml) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(compPrepHtml);
    } else {
      // Try re-reading in case it was deployed after server start
      try {
        compPrepHtml = fs.readFileSync(path.join(__dirname, 'comp-prep.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(compPrepHtml);
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>Competition Prep page not found</h1><p>The comp-prep.html file is missing from the deployment.</p>');
      }
    }
    return;
  }

  // Serve uploaded comp-prep files
  if (req.url.startsWith('/api/comp-prep-file/') && req.method === 'GET') {
    const fileName = decodeURIComponent(pathOnly.split('/api/comp-prep-file/')[1]);
    const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '');
    const filePath = path.join(COMP_PREP_FILES_DIR, safeName);
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(safeName).toLowerCase();
        const mimeTypes = {'.pdf':'application/pdf','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.heic':'image/heic','.txt':'text/plain'};
        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] || 'application/octet-stream',
          'Content-Disposition': 'inline; filename="' + safeName + '"',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'File not found' }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // === ASSIGNMENTS API ===
  // List everything the scheduler has generated, newest first.
  if (pathOnly === '/api/assignments' && req.method === 'GET') {
    const items = listAssignments().map(a => ({
      id: a.id, subject: a.subject, title: a.title, date: a.date,
      level: a.level, status: a.status, answerMode: a.answerMode,
      externalUrl: a.externalUrl,
      submittedAt: a.submission ? a.submission.submittedAt : null,
      score: a.submission && a.submission.score != null ? a.submission.score : null
    }));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ count: items.length, assignments: items }));
    return;
  }

  // Full assignment including its HTML body
  if (pathOnly.startsWith('/api/assignments/') && req.method === 'GET') {
    const id = decodeURIComponent(pathOnly.split('/api/assignments/')[1]);
    const a = getAssignment(id);
    if (!a) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Assignment not found', id: id }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(a));
    return;
  }

  // Record the student's answer against an assignment
  if (pathOnly.startsWith('/api/assignment-submit/') && req.method === 'POST') {
    const id = decodeURIComponent(pathOnly.split('/api/assignment-submit/')[1]);
    const a = getAssignment(id);
    if (!a) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Assignment not found' }));
      return;
    }
    try {
      const body = JSON.parse(await readBody(req));
      a.submission = {
        text: body.text || '',
        fileName: body.fileName || null,
        fileData: body.fileData || null,
        feedback: body.feedback || null,
        score: body.score != null ? body.score : null,
        submittedAt: new Date().toISOString()
      };
      a.status = 'done';
      saveAssignmentRecord(a);

      // Close the loop: a marked assignment adjusts the level used to
      // generate the next one.
      const adjustment = applyAssignmentToProgress(
        body.username || 'riyansh',
        a.subject,
        a.submission.score
      );

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, id: a.id, status: a.status, levelChange: adjustment }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve writing submission page: /writing/submit
  if (req.url.startsWith('/writing/submit')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(writingSubmitHtml);
    return;
  }

  // Serve quiz files: /quiz/YYYY-MM-DD
  var quizMatch = req.url.match(/^\/quiz\/(\d{4}-\d{2}-\d{2})$/);
  if (quizMatch) {
    var quizFile = path.join(__dirname, 'quiz-' + quizMatch[1] + '.html');
    try {
      var qdata = fs.readFileSync(quizFile, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(qdata);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>Quiz not found</h1><p>This quiz has not been published yet. Check back later!</p>');
    }
    return;
  }

  // Serve PWA files
  var STATIC_FILES = {
    '/manifest.json': { file: 'manifest.json', type: 'application/json' },
    '/sw.js': { file: 'sw.js', type: 'application/javascript' },
    '/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
    '/icon-512.png': { file: 'icon-512.png', type: 'image/png' }
  };

  if (STATIC_FILES[req.url]) {
    var sf = STATIC_FILES[req.url];
    var filePath = path.join(__dirname, sf.file);
    try {
      var sdata = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': sf.type,
        'Cache-Control': sf.type.includes('javascript') ? 'no-cache' : 'public, max-age=86400'
      });
      res.end(sdata);
    } catch (e) {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // Serve the portal
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  res.end(indexHtml);
});

// =====================================================================
// === AUTONOMOUS COMPETITION PREP SYSTEM ===
// Runs entirely on the server — no human intervention needed.
// 1. Loads questions from question-bank.json (no AI API dependency)
// 2. Reads Riyansh's past scores to adapt difficulty
// 3. Creates assignment via internal API
// 4. Sends emails via Resend (free tier, no Gmail needed)
// 5. Runs on a Mon/Wed/Fri schedule via node-cron
// =====================================================================

// --- Question Bank Loader ---
let QUESTION_BANK = [];
try {
  const bankPath = path.join(__dirname, 'question-bank.json');
  const bankData = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
  QUESTION_BANK = bankData.questions || [];
  console.log('Question bank loaded:', QUESTION_BANK.length, 'questions');
} catch (e) {
  console.warn('Could not load question-bank.json:', e.message);
}

// --- Scheduler History (persisted) ---
const SCHEDULER_LOG_FILE = path.join(DATA_ROOT, 'scheduler-log.json');
function readSchedulerLog() {
  try {
    if (fs.existsSync(SCHEDULER_LOG_FILE))
      return JSON.parse(fs.readFileSync(SCHEDULER_LOG_FILE, 'utf8'));
  } catch (e) {}
  return { runs: [], errors: [] };
}
function appendSchedulerLog(entry) {
  const log = readSchedulerLog();
  log.runs.push(entry);
  if (log.runs.length > 100) log.runs = log.runs.slice(-100);
  fs.writeFileSync(SCHEDULER_LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
}
function appendSchedulerError(entry) {
  const log = readSchedulerLog();
  log.errors.push(entry);
  if (log.errors.length > 50) log.errors = log.errors.slice(-50);
  fs.writeFileSync(SCHEDULER_LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
}

// --- Adaptive Engine ---
// Reads past competition prep results and picks 5 questions at the right level.
function getAdaptiveDifficulty(username) {
  // Read all completed assignments
  const files = fs.readdirSync(COMP_PREP_DIR).filter(f => f.startsWith('cp_') && f.endsWith('.json'));
  const results = [];
  files.forEach(f => {
    try {
      const asg = JSON.parse(fs.readFileSync(path.join(COMP_PREP_DIR, f), 'utf8'));
      if (asg.username === username && asg.result) {
        results.push({
          date: asg.date,
          score: asg.result.score,
          total: asg.result.total,
          pct: asg.result.percentage,
          questions: asg.questions
        });
      }
    } catch (e) {}
  });

  // Sort by date descending, take last 5
  results.sort((a, b) => b.date.localeCompare(a.date));
  const recent = results.slice(0, 5);

  if (recent.length === 0) {
    // No history — start at difficulty 1-2
    return { targetDifficulty: 1.5, topicWeights: { logic: 1, number: 1, geometry: 1, combi: 1 }, usedIds: new Set() };
  }

  // Average percentage across recent results
  const avgPct = recent.reduce((s, r) => s + r.pct, 0) / recent.length;

  // Map average to target difficulty:
  // <40% → 1 (easy), 40-60% → 2 (medium), 60-80% → 3 (hard), >80% → 4 (competition)
  let targetDifficulty;
  if (avgPct < 40) targetDifficulty = 1;
  else if (avgPct < 60) targetDifficulty = 2;
  else if (avgPct < 80) targetDifficulty = 3;
  else targetDifficulty = 4;

  // Check trend: if last 2 scores are rising, push harder; if falling, ease off
  if (recent.length >= 2) {
    if (recent[0].pct > recent[1].pct && recent[0].pct >= 70) {
      targetDifficulty = Math.min(4, targetDifficulty + 0.5);
    } else if (recent[0].pct < recent[1].pct && recent[0].pct < 50) {
      targetDifficulty = Math.max(1, targetDifficulty - 0.5);
    }
  }

  // Track which question IDs were already used
  const usedIds = new Set();
  results.forEach(r => {
    (r.questions || []).forEach(q => { if (q.id) usedIds.add(q.id); });
  });

  // Topic accuracy from recent questions
  const topicStats = {};
  recent.forEach(r => {
    (r.questions || []).forEach((q, i) => {
      const t = (q.topic || '').toLowerCase();
      if (!topicStats[t]) topicStats[t] = { correct: 0, total: 0 };
      topicStats[t].total++;
      // Check if this question was answered correctly
      const detail = r.questions[i];
      // We can approximate from overall score
    });
  });

  // Weight topics — give more weight to weaker ones
  const topicWeights = { logic: 1, number: 1, geometry: 1, combi: 1 };

  return { targetDifficulty, topicWeights, usedIds };
}

function pickQuestions(username, count) {
  if (QUESTION_BANK.length === 0) return [];
  count = count || 5;

  const { targetDifficulty, topicWeights, usedIds } = getAdaptiveDifficulty(username);

  // Filter out already-used questions
  let available = QUESTION_BANK.filter(q => !usedIds.has(q.id));
  if (available.length < count) {
    // Not enough unused questions — allow reuse of older ones
    available = QUESTION_BANK.slice();
  }

  // Score each question by how close its difficulty is to the target
  // and ensure topic variety
  const scored = available.map(q => {
    const diffScore = 1 / (1 + Math.abs(q.difficulty - targetDifficulty));
    const topicBoost = topicWeights[q.topic] || 1;
    const randomJitter = 0.5 + Math.random(); // prevent always picking same order
    return { q, score: diffScore * topicBoost * randomJitter };
  });

  scored.sort((a, b) => b.score - a.score);

  // Pick top candidates but ensure topic variety (max 2 per topic)
  const picked = [];
  const topicCount = {};
  for (const s of scored) {
    if (picked.length >= count) break;
    const t = s.q.topic;
    topicCount[t] = (topicCount[t] || 0);
    if (topicCount[t] >= 2) continue; // skip if already 2 from this topic
    picked.push(s.q);
    topicCount[t]++;
  }

  // If we still need more, fill without topic constraint
  if (picked.length < count) {
    for (const s of scored) {
      if (picked.length >= count) break;
      if (!picked.includes(s.q)) picked.push(s.q);
    }
  }

  // Shuffle the final selection
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }

  // Number them
  return picked.map((q, i) => ({
    n: i + 1,
    id: q.id,
    text: q.text,
    topic: q.topic.charAt(0).toUpperCase() + q.topic.slice(1),
    difficulty: ['Easy', 'Medium', 'Hard', 'Competition-level'][q.difficulty - 1] || 'Medium',
    answer: q.answer,
    solution: q.solution
  }));
}

// --- Resend Email Sender ---
// Uses the Resend API (https://resend.com) to send real emails.
// Free tier: 100 emails/month, plenty for Mon/Wed/Fri assignments.
// Requires RESEND_API_KEY env var + a verified sender domain or onboarding@resend.dev.
// Sends to each recipient in its own request. Batching them into one call
// means a single rejected address (e.g. the sandbox limit) also blocks the
// recipients that would have worked.
async function sendResendEmailEach(recipients, subject, htmlBody) {
  const list = Array.isArray(recipients) ? recipients : [recipients];
  const results = [];
  for (const addr of list) {
    try {
      const r = await sendResendEmail(addr, subject, htmlBody);
      results.push({ to: addr, ok: true, id: r && r.id });
      console.log('Email sent to', addr);
    } catch (e) {
      results.push({ to: addr, ok: false, error: e.message });
      console.error('Email FAILED for', addr, '-', e.message);
      try {
        appendSchedulerError({
          date: new Date().toISOString().slice(0, 10),
          time: new Date().toISOString(),
          type: 'email',
          recipient: addr,
          error: e.message
        });
      } catch (logErr) {}
    }
  }
  const delivered = results.filter(r => r.ok).length;
  return { delivered: delivered, failed: list.length - delivered, results: results };
}

function sendResendEmail(to, subject, htmlBody) {
  return new Promise((resolve, reject) => {
    // Trim in case the key was pasted with a trailing newline or space
    const apiKey = (process.env.RESEND_API_KEY || '').trim();
    if (!apiKey) {
      reject(new Error('RESEND_API_KEY not set. Add it in Railway environment variables.'));
      return;
    }

    // Resend's free onboarding sender — works immediately, no domain verification needed
    const from = process.env.RESEND_FROM || 'Riyansh Portal <onboarding@resend.dev>';

    const payload = JSON.stringify({
      from: from,
      to: Array.isArray(to) ? to : [to],
      subject: subject,
      html: htmlBody
    });

    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else if (res.statusCode === 403 && /resend\.dev|verify a domain|own email/i.test(data)) {
            // Resend's sandbox sender can only deliver to the address that owns
            // the Resend account. Any other recipient is rejected with a 403.
            reject(new Error(
              'RESEND_SANDBOX_LIMIT: The sender onboarding@resend.dev can only deliver to the email address ' +
              'that registered the Resend account. To email anyone else, verify a domain at resend.com/domains ' +
              'and set RESEND_FROM to an address on that domain. Raw error: ' + data
            ));
          } else {
            reject(new Error('Resend API error ' + res.statusCode + ': ' + data));
          }
        } catch (e) {
          reject(new Error('Resend response parse error: ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- Create & Send Assignment (the main autonomous action) ---
async function createAndSendAssignment() {
  const username = 'riyansh';
  const studentEmail = STUDENT_EMAIL;
  const parentEmail = PARENT_EMAIL;
  const portalBase = PORTAL_URL.replace(/\/$/, '');
  const today = new Date().toISOString().slice(0, 10);

  console.log('[Scheduler] Creating assignment for', today);

  // 1. Pick adaptive questions
  const questions = pickQuestions(username, 5);
  if (questions.length === 0) {
    throw new Error('No questions available in question bank');
  }

  // 2. Create assignment via internal logic (no HTTP call needed)
  const id = 'cp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const assignment = {
    id: id,
    username: username,
    date: today,
    title: 'Maths Competition Prep - ' + today,
    questions: questions,
    status: 'pending',
    answers: {},
    uploadedFile: null,
    result: null,
    createdAt: new Date().toISOString(),
    generatedBy: 'autonomous-scheduler'
  };
  const fp = path.join(COMP_PREP_DIR, id + '.json');
  fs.writeFileSync(fp, JSON.stringify(assignment, null, 2), 'utf8');
  console.log('[Scheduler] Assignment created:', id);

  const assignmentUrl = portalBase + '/comp-prep/' + id;

  // 3. Build student email (NO solutions, NO answers)
  const diffStars = { 'Easy': '⭐', 'Medium': '⭐⭐', 'Hard': '⭐⭐⭐', 'Competition-level': '⭐⭐⭐⭐' };
  let studentHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#4f46e5;">🧮 Maths Competition Prep - ${today}</h2>
      <p>Hi Riyansh! Here are today's 5 challenge questions. Open the link below to answer them on the portal.</p>
      <hr style="border:1px solid #e5e7eb;">
      <ol>`;

  questions.forEach(q => {
    studentHtml += `
        <li style="margin-bottom:12px;">
          <strong>${q.text}</strong><br>
          <span style="color:#6b7280;font-size:0.9em;">Topic: ${q.topic} | Difficulty: ${diffStars[q.difficulty] || q.difficulty}</span>
        </li>`;
  });

  studentHtml += `
      </ol>
      <hr style="border:1px solid #e5e7eb;">
      <p style="text-align:center;">
        <a href="${assignmentUrl}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:white;text-decoration:none;border-radius:8px;font-weight:bold;">Open Portal & Answer</a>
      </p>
      <p style="color:#6b7280;font-size:0.85em;">You can type your answers or upload a photo of your working. Solutions are revealed after you submit!</p>
    </div>`;

  // 4. Build parent email (FULL solutions)
  let parentHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#4f46e5;">🔑 Answer Key - Maths Prep - ${today}</h2>
      <p>This is the parent answer key for today's competition prep assignment.</p>
      <p><a href="${assignmentUrl}">View Riyansh's submission</a></p>
      <hr style="border:1px solid #e5e7eb;">`;

  questions.forEach(q => {
    parentHtml += `
      <div style="margin-bottom:16px;padding:12px;background:#f9fafb;border-radius:8px;">
        <strong>Q${q.n}. ${q.text}</strong><br>
        <span style="color:#6b7280;">Topic: ${q.topic} | ${diffStars[q.difficulty] || q.difficulty}</span><br>
        <span style="color:#16a34a;font-weight:bold;">Answer: ${q.answer}</span><br>
        <em style="color:#374151;">${q.solution}</em>
      </div>`;
  });

  parentHtml += `
      <hr style="border:1px solid #e5e7eb;">
      <p style="color:#6b7280;font-size:0.85em;">Riyansh's portal page will auto-mark typed answers. If he uploads a photo, review it manually.</p>
    </div>`;

  // 5. Send emails via Resend
  const studentResult = await sendResendEmailEach(
    [studentEmail, parentEmail],
    'Maths Competition Prep - ' + today + ' - Your Challenge!',
    studentHtml
  );
  console.log('[Scheduler] Challenge delivered to ' + studentResult.delivered + ' of ' + (studentResult.delivered + studentResult.failed) + ' recipients');

  const parentResult = await sendResendEmail(
    parentEmail,
    'Answer Key - Maths Prep - ' + today,
    parentHtml
  );
  console.log('[Scheduler] Parent email sent:', parentResult.id || 'ok');

  recordAssignment({
    id: 'maths-' + today,
    subject: 'maths',
    title: 'Maths Competition Prep',
    date: today,
    html: studentHtml,
    externalUrl: assignmentUrl,
    answerMode: 'link'
  });

  return { assignmentId: id, url: assignmentUrl, emailsSent: true };
}

// --- Cron Scheduler ---
// Runs Mon/Wed/Fri at 7:00 AM HKT (23:00 UTC the previous day).
// Falls back to setInterval if node-cron is not installed.
let schedulerEnabled = true; // can toggle via admin API
let schedulerStatus = 'initialising';
// Throttles /api/email-test so the endpoint cannot be used to spam
let lastEmailTestAt = 0;

function getNextRunTime() {
  // Calculate when the next Mon/Wed/Fri 7am HKT is
  const now = new Date();
  const hkt = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Hong_Kong' }));
  const dayOfWeek = hkt.getDay(); // 0=Sun
  const hour = hkt.getHours();

  // Target days: Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6
  const targets = [1, 2, 3, 4, 5, 6];
  let daysAhead = null;

  for (let d = 0; d <= 7; d++) {
    const futureDay = (dayOfWeek + d) % 7;
    if (targets.includes(futureDay)) {
      if (d === 0 && hour >= 7) continue; // already past 7am today
      daysAhead = d;
      break;
    }
  }

  if (daysAhead === null) daysAhead = 1; // fallback
  const next = new Date(hkt);
  next.setDate(next.getDate() + daysAhead);
  next.setHours(7, 0, 0, 0);
  return next;
}

async function schedulerTick() {
  if (!schedulerEnabled) {
    schedulerStatus = 'paused';
    return;
  }
  if (!process.env.RESEND_API_KEY) {
    schedulerStatus = 'waiting-for-api-key';
    return;
  }

  // Check if today is a scheduled day and it's past 7am HKT
  // FULL SCHEDULE:
  // Mon = Maths Competition Prep
  // Tue = English Writing (Creative)
  // Wed = Maths Competition Prep + Science Video
  // Thu = English Writing (Structured)
  // Fri = Maths Competition Prep
  // Sat = Coding Lesson
  // Sun = Weekly Progress Report
  const now = new Date();
  const hkt = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Hong_Kong' }));
  const dayOfWeek = hkt.getDay();
  const hour = hkt.getHours();

  // Determine what tasks run today
  const todayTasks = [];
  if ([1, 3, 5].includes(dayOfWeek)) todayTasks.push('maths-prep');     // Mon, Wed, Fri
  if ([2, 4].includes(dayOfWeek)) todayTasks.push('english-writing');    // Tue, Thu
  if (dayOfWeek === 3) todayTasks.push('science-video');                 // Wed
  if (dayOfWeek === 6) todayTasks.push('coding-lesson');                 // Sat
  if (dayOfWeek === 0) todayTasks.push('weekly-report');                 // Sun

  if (todayTasks.length === 0) {
    schedulerStatus = 'idle (not a scheduled day)';
    return;
  }

  const today = hkt.getFullYear() + '-' + String(hkt.getMonth() + 1).padStart(2, '0') + '-' + String(hkt.getDate()).padStart(2, '0');
  const log = readSchedulerLog();

  // Filter out tasks that already ran today
  const pendingTasks = todayTasks.filter(taskType => {
    return !log.runs.some(r => r.date === today && r.success && (r.type === taskType || (!r.type && taskType === 'maths-prep')));
  });

  if (pendingTasks.length === 0) {
    schedulerStatus = 'done-for-today';
    return;
  }

  if (hour < 7) {
    schedulerStatus = 'waiting (before 7am HKT)';
    return;
  }

  // Time to run!
  schedulerStatus = 'running';

  for (const taskType of pendingTasks) {
    try {
      let result;
      switch (taskType) {
        case 'maths-prep':
          console.log('[Scheduler] Running maths assignment for', today);
          result = await createAndSendAssignment();
          appendSchedulerLog({ date: today, time: new Date().toISOString(), success: true, type: 'maths-prep', assignmentId: result.assignmentId, url: result.url });
          console.log('[Scheduler] Maths prep completed');
          break;

        case 'english-writing':
          console.log('[Scheduler] Running English writing prompt for', today);
          result = await createAndSendWritingPrompt();
          appendSchedulerLog({ date: today, time: new Date().toISOString(), success: true, type: 'english-writing', promptTitle: result.promptTitle, level: result.level });
          console.log('[Scheduler] Writing prompt completed');
          break;

        case 'science-video':
          console.log('[Scheduler] Running science video assignment for', today);
          result = await createAndSendScienceEmail();
          appendSchedulerLog({ date: today, time: new Date().toISOString(), success: true, type: 'science-video', lessonTitle: result.lessonTitle, topic: result.topic });
          console.log('[Scheduler] Science video completed');
          break;

        case 'coding-lesson':
          console.log('[Scheduler] Running coding lesson for', today);
          result = await createAndSendCodingEmail();
          appendSchedulerLog({ date: today, time: new Date().toISOString(), success: true, type: 'coding-lesson', missionName: result.missionName, stage: result.stage });
          console.log('[Scheduler] Coding lesson completed');
          break;

        case 'weekly-report':
          console.log('[Scheduler] Running weekly progress report for', today);
          result = await createAndSendWeeklyReport();
          appendSchedulerLog({ date: today, time: new Date().toISOString(), success: true, type: 'weekly-report', overallPct: result.overallPct });
          console.log('[Scheduler] Weekly report completed');
          break;
      }
    } catch (e) {
      console.error('[Scheduler] Error in', taskType + ':', e.message);
      appendSchedulerError({ date: today, time: new Date().toISOString(), type: taskType, error: e.message });
      schedulerStatus = 'error: ' + taskType + ' — ' + e.message;
    }
  }

  schedulerStatus = 'done-for-today';
}

// Check every 15 minutes
const SCHEDULER_INTERVAL = 15 * 60 * 1000;
setInterval(schedulerTick, SCHEDULER_INTERVAL);
// Also run once on startup (after 10 sec delay to let everything initialise)
setTimeout(schedulerTick, 10000);
schedulerStatus = 'active';
console.log('[Scheduler] Autonomous scheduler started. Checks every 15 minutes.');
console.log('[Scheduler] Mon/Wed/Fri: Maths | Tue/Thu: Writing | Wed: Science | Sat: Coding | Sun: Report');

// =====================================================================
// === AUTONOMOUS ENGLISH WRITING PROMPT SYSTEM ===
// Runs on Tue/Thu at 7am HKT via the same scheduler.
// Reads Riyansh's performance data to adapt the prompt difficulty.
// Sends email via Resend (same as maths assignments).
// =====================================================================

const WRITING_PROMPTS = {
  creative: [
    {
      title: 'The Midnight Market',
      prompt: 'Imagine you discover a secret market that only appears at midnight in your neighbourhood. The stalls sell things you can\'t find anywhere else — bottles of captured dreams, maps to hidden places, or boxes that whisper secrets. Write a story about your visit to the Midnight Market. What do you find? Who do you meet? What happens when you try to buy something unusual?'
    },
    {
      title: 'The Door in the Tree',
      prompt: 'While exploring a park, you find a tiny door carved into the trunk of an old tree. When you open it, you discover a world inside. Write a story about what you find on the other side. Who lives there? How is it different from our world? What adventure do you go on?'
    },
    {
      title: 'The Last Day of Summer',
      prompt: 'It is the very last day of summer holidays. You want to make it the most memorable day ever. Write a diary entry describing your perfect last day — where you go, who you are with, and why this day matters to you.'
    },
    {
      title: 'The Robot Who Wanted a Pet',
      prompt: 'In a city where everyone has a robot helper, one robot decides it wants a pet of its own. But robots don\'t usually have pets! Write a story about this robot\'s search for the perfect pet. What kind of animal does it choose? What funny problems come up?'
    },
    {
      title: 'Lost in the Supermarket',
      prompt: 'You are in a huge supermarket when the lights go out. When they come back on, everything has changed — the aisles are rearranged, the products are strange, and you seem to be the only person left. Write a story about what happens next.'
    },
    {
      title: 'The Message in a Bottle',
      prompt: 'While at the beach, you find a glass bottle with a rolled-up letter inside. The message is old and faded, but you can just make out the words. Write a story about the message, who wrote it, and the adventure it leads you on.'
    },
    {
      title: 'My Superpower for a Day',
      prompt: 'You wake up one morning and discover you have a superpower — but it will only last 24 hours. Write a story about your day. What power do you have? How do you use it? What happens when it starts to fade?'
    },
    {
      title: 'The Talking Animal',
      prompt: 'One morning, your pet (or an animal you meet) starts talking to you in perfect English. No one else can hear it. Write a story about your conversation and the adventure you go on together.'
    }
  ],
  structured: [
    {
      title: 'Should Children Have Homework?',
      prompt: 'Some people think homework helps children learn, while others believe it takes away time for play and rest. Write a persuasive essay arguing YOUR opinion. Give at least two strong reasons to support your view, and explain why someone who disagrees might be wrong.'
    },
    {
      title: 'A Letter to the Head Teacher',
      prompt: 'Your school is thinking about making one big change (e.g., longer lunch breaks, no uniforms, more PE lessons, or a school garden). Write a formal letter to your Head Teacher suggesting a change you would like. Explain why it would benefit students and how it could work.'
    },
    {
      title: 'My Favourite Place - A Travel Report',
      prompt: 'Think of a place you have visited or would like to visit (a city, a park, a country). Write an informational report about this place. Include: where it is, what you can see and do there, why it is special, and who would enjoy visiting.'
    },
    {
      title: 'How to Make the Perfect Sandwich',
      prompt: 'Write a set of clear instructions explaining how to make your favourite sandwich (or any simple recipe). Include an introduction explaining why this sandwich is great, a list of ingredients, step-by-step instructions, and a top tip for making it even better.'
    },
    {
      title: 'Should Plastic Be Banned?',
      prompt: 'Plastic is useful but causes pollution. Write a balanced discussion giving arguments FOR and AGAINST banning single-use plastic. End with your own conclusion — what do YOU think should happen?'
    },
    {
      title: 'A Newspaper Report',
      prompt: 'Something unusual has happened at your school (a rare animal was found in the playground, a mysterious package was delivered, or the school broke a world record). Write a newspaper report about the event. Include a headline, who/what/where/when/why, and quotes from witnesses.'
    },
    {
      title: 'Book Review',
      prompt: 'Think of a book you have read recently (or a story you know well). Write a review of it. Include: the title and author, a brief summary (without spoilers!), what you liked and didn\'t like, and who you would recommend it to.'
    },
    {
      title: 'An Application Letter',
      prompt: 'Your school is looking for a student to be the new "Reading Ambassador" (or Sports Captain, Eco Leader, etc.). Write a formal letter applying for the role. Explain why you are the right person, what skills you have, and what you would do in the role.'
    }
  ]
};

const POWER_WORDS_BANK = [
  { word: 'glimmering', meaning: 'shining with a soft, unsteady light' },
  { word: 'peculiar', meaning: 'strange or unusual' },
  { word: 'whispered', meaning: 'spoke very quietly' },
  { word: 'cautiously', meaning: 'carefully, to avoid danger' },
  { word: 'vanished', meaning: 'disappeared suddenly' },
  { word: 'magnificent', meaning: 'extremely beautiful or impressive' },
  { word: 'reluctantly', meaning: 'unwillingly, not wanting to do something' },
  { word: 'ancient', meaning: 'very old, from long ago' },
  { word: 'enormous', meaning: 'very large in size' },
  { word: 'trembling', meaning: 'shaking slightly from fear or excitement' },
  { word: 'gradually', meaning: 'slowly, step by step' },
  { word: 'essential', meaning: 'absolutely necessary' },
  { word: 'furthermore', meaning: 'in addition to what has been said' },
  { word: 'significant', meaning: 'important or large enough to matter' },
  { word: 'demonstrate', meaning: 'to show or prove something clearly' },
  { word: 'frequently', meaning: 'happening often' },
  { word: 'consequences', meaning: 'results or effects of an action' },
  { word: 'perspective', meaning: 'a point of view or way of thinking' },
  { word: 'mysterious', meaning: 'difficult to understand or explain' },
  { word: 'swiftly', meaning: 'quickly and smoothly' }
];

// Pick 5 random power words, preferring creative/structured vocab as appropriate
function pickPowerWords(type) {
  const pool = type === 'creative'
    ? POWER_WORDS_BANK.filter(w => !['furthermore', 'significant', 'demonstrate', 'consequences', 'essential', 'frequently'].includes(w.word))
    : POWER_WORDS_BANK.filter(w => !['glimmering', 'whispered', 'trembling', 'vanished', 'mysterious', 'swiftly'].includes(w.word));
  const shuffled = pool.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 5);
}

// Pick a prompt that hasn't been used recently (check scheduler log)
function pickWritingPrompt(type) {
  const log = readSchedulerLog();
  const recentTitles = (log.runs || [])
    .filter(r => r.type === 'english-writing')
    .slice(-6)
    .map(r => r.promptTitle);

  const pool = WRITING_PROMPTS[type] || WRITING_PROMPTS.creative;
  // Prefer unused prompts
  const unused = pool.filter(p => !recentTitles.includes(p.title));
  const available = unused.length > 0 ? unused : pool;
  return available[Math.floor(Math.random() * available.length)];
}

// Determine writing level from performance data
// Reads the student's real performance to decide writing difficulty.
//
// This previously looked for perfData.progress.english.writing.lv and .c/.t
// counters. The performance file the portal actually uploads has no
// "progress" key at all — it stores topicLevels / topicAccuracy, with ok/no
// counters. So every lookup missed and the level was pinned at 2 forever,
// with punctuation and reading always reported weak. Now it reads the real
// shape, and falls back to the full sync record if one exists.
function getWritingLevel(perfData, username) {
  const fallback = { level: 2, punctuationWeak: true, readingWeak: false, writingsCount: 0 };
  if (!perfData && !username) return fallback;

  // The cross-device sync file holds the complete progress object
  let syncProgress = null;
  try {
    if (username) {
      const fp = getSyncPath(username);
      if (fs.existsSync(fp)) {
        const rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
        syncProgress = rec && rec.progress ? rec.progress : null;
      }
    }
  } catch (e) {}

  const topicLevels = (perfData && perfData.topicLevels) || {};
  const topicAcc = (perfData && perfData.topicAccuracy) || {};

  // Reads a topic from whichever source has it, normalising ok/no counters
  function topic(name) {
    const eng = (syncProgress && syncProgress.english) || {};
    if (eng[name] && ((eng[name].ok || 0) + (eng[name].no || 0)) > 0) {
      return { lv: eng[name].lv || null, ok: eng[name].ok || 0, no: eng[name].no || 0 };
    }
    const acc = topicAcc['english.' + name];
    if (acc) return { lv: acc.level || null, ok: acc.ok || 0, no: acc.no || 0 };
    const lv = topicLevels['english.' + name];
    return lv ? { lv: lv, ok: 0, no: 0 } : null;
  }

  function accuracyOf(t) {
    if (!t) return null;
    const total = t.ok + t.no;
    return total > 0 ? t.ok / total : null;
  }

  const writing = topic('writing');
  const punct = topic('punctuation');
  const reading = topic('reading');

  // Prefer the stored level; otherwise infer from accuracy
  let level = 2;
  if (writing && writing.lv) {
    level = Math.max(1, Math.min(5, writing.lv));
  } else {
    const acc = accuracyOf(writing);
    if (acc !== null) level = acc >= 0.8 ? 4 : acc >= 0.6 ? 3 : acc >= 0.4 ? 2 : 1;
  }

  // A topic counts as weak only when there is evidence for it. With no data
  // we assume weak, so early assignments include the extra support.
  const punctAcc = accuracyOf(punct);
  const readAcc = accuracyOf(reading);
  const punctuationWeak = punctAcc === null ? true : punctAcc < 0.6;
  const readingWeak = readAcc === null ? true : readAcc < 0.6;

  const writingsCount = (syncProgress && Array.isArray(syncProgress.wr))
    ? syncProgress.wr.length
    : ((perfData && typeof perfData.writings === 'number') ? perfData.writings : 0);

  return { level, punctuationWeak, readingWeak, writingsCount };
}

// Build the writing prompt email HTML
function buildWritingEmail(promptData, levelInfo, type, today) {
  const { level, punctuationWeak, readingWeak } = levelInfo;
  const powerWords = pickPowerWords(type);
  const typeLabel = type === 'creative' ? 'Creative Writing' : 'Structured Writing';
  const portalUrl = PORTAL_URL;

  // Word count by level
  const wordCounts = { 1: '100–150', 2: '100–150', 3: '150–200', 4: '200–250', 5: '200–300' };
  const wordTarget = wordCounts[level] || '150–200';

  // Scaffolding varies by level
  let scaffoldingHtml = '';

  if (level <= 2) {
    // Heavy scaffolding: sentence starters + vocabulary bank + example paragraph
    scaffoldingHtml = `
      <h3 style="color:#A23B72;">🏗️ Sentence Starters (use these to help!)</h3>
      ${type === 'creative' ? `
      <ul style="margin:8px 0;">
        <li><em>One ${['evening', 'morning', 'night'][Math.floor(Math.random()*3)]}, I discovered something extraordinary...</em></li>
        <li><em>At first, I couldn't believe my eyes because...</em></li>
        <li><em>The most surprising thing was...</em></li>
        <li><em>In the end, I learned that...</em></li>
      </ul>` : `
      <ul style="margin:8px 0;">
        <li><em>In my opinion, I believe that...</em></li>
        <li><em>One important reason is...</em></li>
        <li><em>On the other hand, some people think...</em></li>
        <li><em>In conclusion, I think that...</em></li>
      </ul>`}
      <hr style="border:1px solid #eee;">`;
  }

  if (level >= 3 && level <= 4) {
    // Paragraph planning template
    scaffoldingHtml = `
      <h3 style="color:#A23B72;">🗺️ Plan Your Writing</h3>
      <p>Before you start, jot down a quick plan:</p>
      <table style="width:100%;border-collapse:collapse;margin:10px 0;">
        <tr style="background:#f9f9f9;">
          <td style="padding:8px;border:1px solid #ddd;width:30%;"><strong>${type === 'creative' ? 'Opening' : 'Introduction'}</strong></td>
          <td style="padding:8px;border:1px solid #ddd;">${type === 'creative' ? 'Set the scene. Where are you? What time is it? (2–3 sentences)' : 'Introduce the topic. What is your main point? (2–3 sentences)'}</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #ddd;"><strong>${type === 'creative' ? 'Middle' : 'Main Body'}</strong></td>
          <td style="padding:8px;border:1px solid #ddd;">${type === 'creative' ? 'What happens? Use senses — sight, sound, smell. (4–6 sentences)' : 'Give 2–3 reasons or points. Use examples. (4–6 sentences)'}</td>
        </tr>
        <tr style="background:#f9f9f9;">
          <td style="padding:8px;border:1px solid #ddd;"><strong>${type === 'creative' ? 'Ending' : 'Conclusion'}</strong></td>
          <td style="padding:8px;border:1px solid #ddd;">${type === 'creative' ? 'How does it end? What do you take away? (2–3 sentences)' : 'Summarise your view. End with a strong final sentence. (2–3 sentences)'}</td>
        </tr>
      </table>
      <hr style="border:1px solid #eee;">`;
  }

  // Level 4-5: self-editing checklist is the main scaffold (included below for all levels)

  // Punctuation tips (if weak)
  let punctuationTip = '';
  if (punctuationWeak) {
    punctuationTip = `
      <p style="margin-top:5px;font-size:13px;color:#777;background:#fff8e1;padding:10px;border-radius:4px;">
        <strong>💡 Punctuation Focus:</strong> Watch out for run-on sentences! If you join two ideas with just a comma, try using a full stop or connecting words like "and", "but", or "so" instead.<br>
        <em>❌ I went to the shop, I bought some milk.</em><br>
        <em>✅ I went to the shop. I bought some milk.</em><br>
        <em>✅ I went to the shop and bought some milk.</em>
      </p>`;
  }

  // Reading passage (if reading is weak, give a short inspiration passage for creative)
  let readingInspiration = '';
  if (readingWeak && type === 'creative') {
    readingInspiration = `
      <div style="background:#f0f7ff;padding:12px;border-left:4px solid #2E86AB;border-radius:4px;margin:10px 0;">
        <strong>📖 Read this short passage first for inspiration:</strong><br><br>
        <em>The old clock tower stood at the edge of town, half-hidden by ivy. Nobody went there anymore — or so everyone thought. But if you looked carefully at midnight, you might notice a faint golden light glowing from the top window, and if you listened closely, you might hear the softest sound of music drifting down through the cold night air.</em>
      </div>`;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;padding:20px;">
      <h2 style="color:#2E86AB;">🖊️ English ${typeLabel} - ${today}</h2>
      <p>Hi Riyansh!</p>
      <p>${type === 'creative' ? 'Time for some creative writing! Let your imagination fly.' : 'Time to practise your formal writing skills. Think carefully about structure.'}</p>

      ${readingInspiration}

      <hr style="border:1px solid #eee;">

      <h3 style="color:#A23B72;">✍️ Your Writing Prompt</h3>
      <div style="background:#f0f7ff;padding:15px;border-left:4px solid #2E86AB;border-radius:4px;font-size:15px;">
        <strong>${promptData.title}</strong><br><br>
        ${promptData.prompt}
      </div>

      <p><strong>Word count target:</strong> ${wordTarget} words</p>

      <hr style="border:1px solid #eee;">

      ${scaffoldingHtml}

      <h3 style="color:#A23B72;">⚡ 5 Power Words to Try</h3>
      <p>Try to use at least <strong>3</strong> of these in your writing:</p>
      <table style="width:100%;border-collapse:collapse;margin:10px 0;">
        ${powerWords.map((pw, i) => `
        <tr${i % 2 === 0 ? ' style="background:#fff3e0;"' : ''}>
          <td style="padding:8px;border:1px solid #ddd;"><strong>${pw.word}</strong></td>
          <td style="padding:8px;border:1px solid #ddd;">${pw.meaning}</td>
        </tr>`).join('')}
      </table>

      <hr style="border:1px solid #eee;">

      <h3 style="color:#A23B72;">✅ Before You Submit — Checklist</h3>
      <table style="width:100%;border-collapse:collapse;margin:10px 0;">
        <tr><td style="padding:6px;border:1px solid #ddd;">☐ Does every sentence start with a <strong>capital letter</strong>?</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:6px;border:1px solid #ddd;">☐ Does every sentence end with a <strong>full stop, question mark, or exclamation mark</strong>?</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd;">☐ Have you checked for <strong>run-on sentences</strong>? (If a sentence has more than 2 ideas, split it!)</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:6px;border:1px solid #ddd;">☐ Have you used <strong>commas</strong> in lists and after introductory words? (e.g., "Suddenly, I saw...")</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd;">☐ Did you use at least <strong>3 Power Words</strong>?</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:6px;border:1px solid #ddd;">☐ Does your writing have a clear <strong>${type === 'creative' ? 'beginning, middle, and ending' : 'introduction, body, and conclusion'}</strong>?</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd;">☐ Read your writing <strong>out loud</strong> — does it sound right?</td></tr>
        ${level >= 4 ? '<tr style="background:#f9f9f9;"><td style="padding:6px;border:1px solid #ddd;">☐ Have you varied your <strong>sentence length</strong>? (Mix short and long sentences)</td></tr>' : ''}
        ${level >= 5 ? '<tr><td style="padding:6px;border:1px solid #ddd;">☐ Read it as if YOU are the teacher — what mark would you give and why?</td></tr>' : ''}
      </table>

      ${punctuationTip}

      <hr style="border:1px solid #eee;">

      <h3 style="color:#A23B72;">📝 How to Submit</h3>
      <p>Click the button below. You can <strong>type</strong> your story, <strong>paste</strong> it in, or <strong>upload a photo, PDF or Word file</strong> if you wrote it on paper or somewhere else. Your AI teacher marks it straight away.</p>
      <p style="text-align:center;">
        <a href="${portalUrl}writing/submit?a=english-${today}" style="display:inline-block;background:#2E86AB;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;">Write &amp; Submit Here</a>
      </p>
      <p style="text-align:center;font-size:13px;color:#666;">
        or open the full portal: <a href="${portalUrl}" style="color:#2E86AB;">${portalUrl}</a>
      </p>
      <p>${type === 'creative' ? 'Have fun with it — your imagination is your superpower! 🚀' : 'Take your time and plan before you write. Good structure = great writing! 📐'}</p>
    </div>`;

  return html;
}

// --- Create & Send English Writing Prompt ---
async function createAndSendWritingPrompt() {
  const username = 'riyansh';
  const studentEmail = STUDENT_EMAIL;
  const parentEmail = PARENT_EMAIL;
  const today = new Date().toISOString().slice(0, 10);

  // Determine day type: Tue = creative, Thu = structured, Sat = creative (bonus)
  const now = new Date();
  const hkt = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Hong_Kong' }));
  const dayOfWeek = hkt.getDay();
  const type = (dayOfWeek === 4) ? 'structured' : 'creative'; // Thu=4 → structured, Tue/Sat → creative

  console.log('[Writing] Generating', type, 'writing prompt for', today);

  // Read performance data (directly from disk, no HTTP needed)
  const perfData = readPerf(username);
  const levelInfo = getWritingLevel(perfData, username);
  console.log('[Writing] Level:', levelInfo.level, '| Punctuation weak:', levelInfo.punctuationWeak, '| Writings done:', levelInfo.writingsCount);

  // Pick a prompt
  const promptData = pickWritingPrompt(type);
  console.log('[Writing] Selected prompt:', promptData.title);

  // Build email
  const htmlBody = buildWritingEmail(promptData, levelInfo, type, today);

  const typeLabel = type === 'creative' ? 'Creative Writing' : 'Structured Writing';
  const subject = 'English Writing - ' + today + ' - Level ' + levelInfo.level + ': ' + typeLabel + ' — ' + promptData.title;

  // Send to each recipient separately so one rejected address
  // cannot block delivery to the other
  const result = await sendResendEmailEach(
    [studentEmail, parentEmail],
    subject,
    htmlBody
  );
  console.log('[Writing] Email delivered to ' + result.delivered + ' of ' + (result.delivered + result.failed) + ' recipients');

  recordAssignment({
    id: 'english-' + today,
    subject: 'english',
    title: promptData.title,
    date: today,
    level: levelInfo.level,
    html: htmlBody,
    answerMode: 'text'
  });

  return { type, promptTitle: promptData.title, level: levelInfo.level, emailSent: true };
}

// =====================================================================
// === AUTONOMOUS SCIENCE VIDEO ASSIGNMENT (Wednesday) ===
// =====================================================================

const SCIENCE_LESSONS = [
  // Biology
  { topic: 'Biology', title: 'How Your Heart Works', videoUrl: 'https://www.youtube.com/watch?v=CWFyxn0qDEU', funFact: 'Your heart beats about 100,000 times every day — that is over 35 million times a year!', prediction: 'Before watching: How many chambers do you think the human heart has?', questions: ['What are the four chambers of the heart called?', 'What is the difference between arteries and veins?', 'Why does your heart beat faster when you exercise?'], activity: 'Place two fingers on the inside of your wrist to find your pulse. Count your heartbeats for 15 seconds and multiply by 4. That is your resting heart rate! Now do 20 star jumps and measure again. Write down both numbers.' },
  { topic: 'Biology', title: 'How Plants Make Food', videoUrl: 'https://www.youtube.com/watch?v=UPBMG5EYydo', funFact: 'A large tree can release about 400 litres of water into the air in one day through its leaves!', prediction: 'Before watching: What do you think plants need to make their own food?', questions: ['What is photosynthesis?', 'What three things do plants need for photosynthesis?', 'What gas do plants release that humans need to breathe?'], activity: 'Take two small plants. Put one in a sunny spot and one in a dark cupboard. Water both the same. After 5 days, draw and compare them. What happened and why?' },
  { topic: 'Biology', title: 'The Human Digestive System', videoUrl: 'https://www.youtube.com/watch?v=VwAoaJxGPJo', funFact: 'If you uncoiled your small intestine, it would be about 6 metres long — taller than a giraffe!', prediction: 'Before watching: How long do you think it takes food to travel through your whole body?', questions: ['What happens to food in your stomach?', 'What is the role of the small intestine?', 'Why is saliva important for digestion?'], activity: 'Draw the digestive system from memory after watching. Label at least 5 parts. Then eat a cracker very slowly — can you feel where each stage happens?' },
  { topic: 'Biology', title: 'Animal Adaptations', videoUrl: 'https://www.youtube.com/watch?v=hrnXJOukNGc', funFact: 'The Arctic fox changes its fur colour from brown in summer to white in winter to blend in with the snow!', prediction: 'Before watching: Can you name an animal that has adapted to survive in an extreme environment?', questions: ['What is an adaptation?', 'Give two examples of structural adaptations.', 'How do behavioural adaptations help animals survive?'], activity: 'Choose an imaginary planet (very hot, very cold, underwater, or no gravity). Design an animal that could survive there. Draw it and label at least 3 adaptations.' },
  // Chemistry
  { topic: 'Chemistry', title: 'States of Matter', videoUrl: 'https://www.youtube.com/watch?v=wclY8F-UoLE', funFact: 'Glass is not actually a solid — it is an extremely slow-moving liquid! Very old windows are thicker at the bottom.', prediction: 'Before watching: Can you name the three states of matter?', questions: ['How are particles arranged differently in solids, liquids, and gases?', 'What is the process called when a liquid turns into a gas?', 'What happens to particles when you heat them?'], activity: 'Fill a glass with ice cubes (solid). Watch them melt into water (liquid). With an adult, boil some water and observe the steam (gas). You just watched all three states of matter!' },
  { topic: 'Chemistry', title: 'Separating Mixtures', videoUrl: 'https://www.youtube.com/watch?v=gLHnp-n38ZQ', funFact: 'Sea water contains about 35 grams of salt per litre. If all the salt in the ocean was spread on land, it would cover everything in a layer 150 metres thick!', prediction: 'Before watching: If you mixed sand and salt together, how could you separate them again?', questions: ['What is filtration used to separate?', 'How does evaporation help separate dissolved substances?', 'What is the difference between a mixture and a compound?'], activity: 'Mix some salt into warm water until it dissolves. Pour a thin layer onto a plate and leave it on a windowsill. Check it after 2 days — you should find salt crystals!' },
  // Physics
  { topic: 'Physics', title: 'Forces and Motion', videoUrl: 'https://www.youtube.com/watch?v=IJWsrxQMoP8', funFact: 'In space, there is almost no friction or air resistance, so if you threw a ball it would keep going forever in a straight line!', prediction: 'Before watching: What do you think would happen if there were no friction on Earth?', questions: ['What is a force?', 'Name two contact forces and two non-contact forces.', 'How do balanced and unbalanced forces affect motion?'], activity: 'Slide a book across different surfaces (smooth table, carpet, sandpaper). Time how far it travels each time. Which surface has the most friction? Make a bar chart of your results.' },
  { topic: 'Physics', title: 'Light and Shadows', videoUrl: 'https://www.youtube.com/watch?v=qdPsc5RGOBU', funFact: 'Light travels at 300,000 kilometres per second. It takes sunlight about 8 minutes to reach Earth!', prediction: 'Before watching: Why do you think shadows change size during the day?', questions: ['Does light travel in straight lines or curves?', 'What happens when light hits an opaque object?', 'Why are shadows longer in the morning and evening than at midday?'], activity: 'On a sunny day, go outside at three different times (morning, noon, afternoon). Trace your shadow with chalk each time. How does it change? Which is longest and why?' },
  // Earth & Space
  { topic: 'Earth & Space', title: 'The Water Cycle', videoUrl: 'https://www.youtube.com/watch?v=al-do-HGuIk', funFact: 'The water you drink today could contain molecules that dinosaurs drank 65 million years ago — water is constantly recycled!', prediction: 'Before watching: Where does rain come from?', questions: ['What are the four main stages of the water cycle?', 'What is the difference between evaporation and condensation?', 'Why is the water cycle important for life on Earth?'], activity: 'Put warm water in a bowl, cover it tightly with cling film, and place an ice cube on top. Watch droplets form underneath — you have made your own mini water cycle!' },
  { topic: 'Earth & Space', title: 'Our Solar System', videoUrl: 'https://www.youtube.com/watch?v=libKVRa01L8', funFact: 'One day on Venus is longer than one year on Venus! It spins so slowly that it takes 243 Earth days to rotate once, but only 225 days to orbit the Sun.', prediction: 'Before watching: Can you name all 8 planets in order from the Sun?', questions: ['What is the difference between inner and outer planets?', 'Why is Earth the only planet known to support life?', 'What is the asteroid belt and where is it?'], activity: 'Create a scale model of the solar system using fruit. The Sun is a watermelon, Mercury is a peppercorn, Venus and Earth are grapes, Mars is a blueberry, Jupiter is a grapefruit, Saturn is an orange, Uranus and Neptune are plums. Lay them out and see the distances!' }
];

function pickScienceLesson() {
  const log = readSchedulerLog();
  const recentTitles = (log.runs || [])
    .filter(r => r.type === 'science-video')
    .slice(-8)
    .map(r => r.lessonTitle);
  const unused = SCIENCE_LESSONS.filter(l => !recentTitles.includes(l.title));
  const pool = unused.length > 0 ? unused : SCIENCE_LESSONS;

  // Prefer topics with lower accuracy
  const perfData = readPerf('riyansh');
  if (perfData && perfData.progress && perfData.progress.science) {
    const sci = perfData.progress.science;
    const topicMap = { 'Biology': 'biology', 'Chemistry': 'chemistry', 'Physics': 'physics', 'Earth & Space': 'earthSpace' };
    // Score each lesson: lower accuracy topics get higher priority
    const scored = pool.map(l => {
      const key = topicMap[l.topic] || l.topic.toLowerCase();
      const topicData = sci[key] || {};
      const total = topicData.t || 0;
      const correct = topicData.c || 0;
      const accuracy = total > 0 ? correct / total : 0;
      const priority = total === 0 ? 100 : (1 - accuracy) * 100; // unseen topics highest priority
      return { lesson: l, priority };
    });
    scored.sort((a, b) => b.priority - a.priority);
    return scored[0].lesson;
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

async function createAndSendScienceEmail() {
  const studentEmail = STUDENT_EMAIL;
  const parentEmail = PARENT_EMAIL;
  const today = new Date().toISOString().slice(0, 10);
  const lesson = pickScienceLesson();
  const portalUrl = PORTAL_URL;

  console.log('[Science] Selected:', lesson.title, '(' + lesson.topic + ')');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;padding:20px;">
      <h2 style="color:#16a34a;">🔬 Science Explorer — ${lesson.topic}</h2>
      <p>Hi Riyansh!</p>
      <p>This week we are exploring <strong>${lesson.topic}</strong>. Get ready for something amazing!</p>

      <div style="background:#f0fdf4;padding:12px;border-left:4px solid #16a34a;border-radius:4px;margin:10px 0;">
        <strong>🤯 Did You Know?</strong><br>
        ${lesson.funFact}
      </div>

      <hr style="border:1px solid #eee;">

      <h3 style="color:#16a34a;">🎬 Today's Video: ${lesson.title}</h3>
      <p style="text-align:center;">
        <a href="${lesson.videoUrl}" style="display:inline-block;background:#ef4444;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">▶ Watch the Video</a>
      </p>

      <hr style="border:1px solid #eee;">

      <h3 style="color:#16a34a;">🔮 Prediction (Before Watching)</h3>
      <p style="background:#fefce8;padding:10px;border-radius:4px;">${lesson.prediction}</p>

      <h3 style="color:#16a34a;">👀 Watch For (Answer These After)</h3>
      <ol>
        ${lesson.questions.map(q => '<li style="margin-bottom:8px;">' + q + '</li>').join('')}
      </ol>

      <hr style="border:1px solid #eee;">

      <h3 style="color:#16a34a;">🧪 Hands-On Activity</h3>
      <p style="background:#f0f7ff;padding:12px;border-radius:4px;">${lesson.activity}</p>

      <hr style="border:1px solid #eee;">

      <p style="text-align:center;">
        <a href="${portalUrl}" style="display:inline-block;background:#2E86AB;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Open Learning Portal</a>
      </p>
      <p>Enjoy exploring! Science is everywhere around you. 🌍</p>
    </div>`;

  const subject = 'Science Explorer - ' + lesson.topic + ': ' + lesson.title + ' - ' + today;
  const result = await sendResendEmailEach([studentEmail, parentEmail], subject, html);
  console.log('[Science] Email delivered to ' + result.delivered + ' of ' + (result.delivered + result.failed) + ' recipients');
  recordAssignment({
    subject: 'science',
    title: lesson.topic + ': ' + lesson.title,
    html: html,
    externalUrl: lesson.videoUrl || null,
    answerMode: 'text'
  });

  return { lessonTitle: lesson.title, topic: lesson.topic, emailSent: true };
}

// =====================================================================
// === AUTONOMOUS CODING LESSON (Saturday) ===
// =====================================================================

// Stage progression: week count from 12 May 2026
function getCodingStage() {
  const startDate = new Date('2026-05-12');
  const now = new Date();
  const weekNum = Math.floor((now - startDate) / (7 * 24 * 60 * 60 * 1000)) + 1;

  // Check if maths accuracy is low (slow down if struggling)
  const perfData = readPerf('riyansh');
  let slowDown = false;
  if (perfData && perfData.progress && perfData.progress.maths) {
    const maths = perfData.progress.maths;
    let totalC = 0, totalT = 0;
    Object.values(maths).forEach(t => { totalC += (t.c || 0); totalT += (t.t || 0); });
    if (totalT > 0 && (totalC / totalT) < 0.4) slowDown = true;
  }

  const adjustedWeek = slowDown ? Math.floor(weekNum * 0.75) : weekNum;

  if (adjustedWeek <= 3) return { stage: 'Scratch Basics', stageNum: 1, week: adjustedWeek };
  if (adjustedWeek <= 6) return { stage: 'Scratch Games', stageNum: 2, week: adjustedWeek - 3 };
  if (adjustedWeek <= 9) return { stage: 'HTML & CSS', stageNum: 3, week: adjustedWeek - 6 };
  if (adjustedWeek <= 12) return { stage: 'JavaScript Basics', stageNum: 4, week: adjustedWeek - 9 };
  return { stage: 'JavaScript Projects', stageNum: 5, week: adjustedWeek - 12 };
}

const CODING_MISSIONS = {
  'Scratch Basics': [
    { mission: 'Operation: First Sprite', brief: 'Create a Scratch project with a character that moves left and right using arrow keys. Make it say "Hello!" when you click on it.', steps: ['Open Scratch at scratch.mit.edu and create a new project.', 'Choose a sprite (character) you like from the library.', 'Add blocks: "when right arrow key pressed → change x by 10" and "when left arrow key pressed → change x by -10".', 'Add "when this sprite clicked → say Hello! for 2 seconds".', 'Test it! Press the green flag and try the arrow keys.'], concept: 'Events & Motion: In coding, we use "events" (like pressing a key) to trigger "actions" (like moving). This is how all games work!', bonus: 'Add a cool background and make the sprite also move up and down with arrow keys.', resource: 'https://scratch.mit.edu' },
    { mission: 'Operation: Costume Change', brief: 'Create a sprite that changes its costume (appearance) when you press the space bar. Make it look like it is animating!', steps: ['Create a new Scratch project and choose a sprite with multiple costumes.', 'Go to the Costumes tab to see all available looks.', 'Add: "when space key pressed → next costume".', 'Add: "when green flag clicked → forever: wait 0.5 seconds, next costume" for auto-animation.', 'Test both — manual and automatic costume switching!'], concept: 'Loops & Animation: The "forever" block is a LOOP — it repeats the same action over and over. All animations in games use loops!', bonus: 'Add sound effects that play each time the costume changes.', resource: 'https://scratch.mit.edu' },
    { mission: 'Operation: Sound Master', brief: 'Create a musical instrument in Scratch! Different keys play different sounds.', steps: ['Create a new project and pick a music-themed backdrop.', 'Add the "Music" extension from the bottom-left + button.', 'Create blocks: "when [a] key pressed → play note 60", "when [s] key pressed → play note 64", etc.', 'Use at least 5 different keys for 5 different notes.', 'Add a sprite that dances (changes costume) when any key is pressed.'], concept: 'Input & Output: Your keyboard INPUTS trigger sound and visual OUTPUTS. Every program follows this pattern: input → process → output!', bonus: 'Record your own sounds and use them instead of notes. Can you play a simple tune?', resource: 'https://scratch.mit.edu' }
  ],
  'Scratch Games': [
    { mission: 'Operation: Maze Runner', brief: 'Build a maze game! The player navigates a character through a maze you draw. If they touch the walls, they go back to the start.', steps: ['Draw a maze as your backdrop using the paint editor. Use thick lines!', 'Make a small sprite as the player and position it at the start.', 'Add arrow-key movement (change x and y by 5).', 'Add: "if touching [wall colour] → go to x: [start] y: [start]".', 'Add a goal sprite — "if touching [goal] → say You win!"'], concept: 'Collision Detection: Games check if objects are touching each other every moment. This "if touching" check runs inside a loop — happening 30+ times per second!', bonus: 'Add a timer so the player can try to beat their best time. Add multiple levels!', resource: 'https://scratch.mit.edu' },
    { mission: 'Operation: Catch the Stars', brief: 'Build a game where stars fall from the sky and the player catches them in a basket. Score points for each catch!', steps: ['Create a basket sprite controlled by mouse x-position (glide to mouse).', 'Create a star sprite that starts at a random x position at the top.', 'Make the star glide down. If it reaches the bottom, hide it and restart at top.', 'Add: "if touching basket → change score by 1, hide, go to random top position, show".', 'Add a score variable and display it on screen.'], concept: 'Variables: A "variable" is like a scoreboard — it stores a number that can change. Score, lives, and level are all variables in real games!', bonus: 'Add bombs that fall too — if you catch a bomb, lose a life! Game over at 0 lives.', resource: 'https://scratch.mit.edu' }
  ],
  'HTML & CSS': [
    { mission: 'Operation: My First Website', brief: 'Create your very first web page! It should have a heading, a paragraph about yourself, and a photo or image.', steps: ['Open a text editor (Notepad or VS Code).', 'Type: <!DOCTYPE html><html><head><title>My Page</title></head><body></body></html>', 'Inside <body>, add <h1>Hello, I am Riyansh!</h1>', 'Add <p>I am 10 years old and I live in Hong Kong.</p>', 'Save as index.html and open it in your browser!'], concept: 'HTML Tags: HTML uses "tags" like <h1> and <p> to tell the browser what each piece of content IS. Tags come in pairs: <h1>...</h1>. The browser reads these tags and displays the content accordingly.', bonus: 'Add an <img> tag with a photo, and a list of your hobbies using <ul> and <li>.', resource: 'https://www.w3schools.com/html/html_intro.asp' },
    { mission: 'Operation: Style Agent', brief: 'Make your website look amazing with CSS! Change colours, fonts, and sizes to create your own design.', steps: ['Open your index.html file from last week.', 'Inside <head>, add: <style> body { font-family: Arial; background-color: #f0f0f0; } </style>', 'Style your heading: h1 { color: blue; text-align: center; }', 'Style your paragraph: p { font-size: 18px; color: #333; }', 'Try changing colours and see what happens!'], concept: 'CSS Selectors: CSS targets HTML elements by their tag name (h1, p), class (.myclass), or id (#myid). It is like giving instructions: "All headings should be blue and centered."', bonus: 'Add a coloured border around your content using: border: 2px solid blue; padding: 20px;', resource: 'https://www.w3schools.com/css/css_intro.asp' }
  ],
  'JavaScript Basics': [
    { mission: 'Operation: Alert & Prompt', brief: 'Make a web page that talks to the user! Ask their name and greet them with a personalised message.', steps: ['Create a new HTML file with a basic structure.', 'Add a <script> tag inside <body>.', 'Type: let name = prompt("What is your name?");', 'Then: alert("Hello, " + name + "! Welcome to my page!");', 'Save and open — it will ask for your name and greet you!'], concept: 'Variables in JS: A "variable" (let name = ...) stores data. Think of it as a labelled box — you put a value in and can use it later. The + operator joins text together.', bonus: 'Ask for their age too, calculate their birth year, and display it!', resource: 'https://www.w3schools.com/js/js_intro.asp' },
    { mission: 'Operation: Click Counter', brief: 'Build a web page with a button that counts how many times it has been clicked. Display the count on screen.', steps: ['Create an HTML file with: <h1 id="counter">0</h1> and <button onclick="addOne()">Click Me!</button>', 'Add a <script> tag.', 'Type: let count = 0;', 'Create the function: function addOne() { count++; document.getElementById("counter").textContent = count; }', 'Save and open — click the button and watch the number grow!'], concept: 'Functions: A function is a reusable block of code with a name. You "call" it when needed (like when a button is clicked). Functions are the building blocks of all programs.', bonus: 'Add a "Reset" button that sets count back to 0. Add CSS to make it look like a real app!', resource: 'https://www.w3schools.com/js/js_functions.asp' }
  ],
  'JavaScript Projects': [
    { mission: 'Operation: Quiz Builder', brief: 'Build your own quiz app! Display questions one at a time, check answers, and show a final score.', steps: ['Create an array of question objects: [{q: "What is 2+2?", a: "4"}, ...]', 'Display the first question in an HTML element.', 'Add an input field and a "Submit" button.', 'Check if the answer matches, update the score, and show the next question.', 'After all questions, display: "You scored X out of Y!"'], concept: 'Arrays & Objects: Arrays store lists ([1,2,3]) and Objects store key-value pairs ({name: "Riyansh"}). Together they can model any data — quiz questions, game characters, or student records!', bonus: 'Add a timer for each question. Show which questions were wrong at the end with the correct answers.', resource: 'https://www.w3schools.com/js/js_arrays.asp' }
  ]
};

async function createAndSendCodingEmail() {
  const studentEmail = STUDENT_EMAIL;
  const parentEmail = PARENT_EMAIL;
  const today = new Date().toISOString().slice(0, 10);
  const stageInfo = getCodingStage();

  const missions = CODING_MISSIONS[stageInfo.stage] || CODING_MISSIONS['Scratch Basics'];
  const log = readSchedulerLog();
  const recentMissions = (log.runs || [])
    .filter(r => r.type === 'coding-lesson')
    .slice(-5)
    .map(r => r.missionName);
  const unused = missions.filter(m => !recentMissions.includes(m.mission));
  const missionPool = unused.length > 0 ? unused : missions;
  const mission = missionPool[Math.floor(Math.random() * missionPool.length)];

  console.log('[Coding] Stage:', stageInfo.stage, '| Mission:', mission.mission);

  const diffStars = { 1: '⭐', 2: '⭐⭐', 3: '⭐⭐⭐', 4: '⭐⭐⭐⭐', 5: '⭐⭐⭐⭐⭐' };
  const difficulty = diffStars[stageInfo.stageNum] || '⭐⭐';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;padding:20px;">
      <h2 style="color:#7c3aed;">🕹️ CODING SATURDAY — Mission Briefing</h2>
      <div style="background:#f5f3ff;padding:15px;border-left:4px solid #7c3aed;border-radius:4px;">
        <p style="margin:0;font-size:13px;color:#6b7280;">CLASSIFIED — FOR AGENT RIYANSH ONLY</p>
        <p style="margin:5px 0 0;font-size:13px;">Stage: <strong>${stageInfo.stage}</strong> | Difficulty: ${difficulty}</p>
      </div>

      <p style="margin-top:15px;">Agent Riyansh, your mission this week...</p>

      <h3 style="color:#7c3aed;">🎯 ${mission.mission}</h3>
      <p style="background:#fefce8;padding:12px;border-radius:4px;">${mission.brief}</p>

      <h3 style="color:#7c3aed;">📋 Steps</h3>
      <ol>
        ${mission.steps.map(s => '<li style="margin-bottom:8px;">' + s + '</li>').join('')}
      </ol>

      <h3 style="color:#7c3aed;">💡 Key Concept</h3>
      <p style="background:#f0f7ff;padding:12px;border-left:4px solid #2E86AB;border-radius:4px;">${mission.concept}</p>

      <hr style="border:1px solid #eee;">

      <h3 style="color:#7c3aed;">🌟 Bonus Challenge</h3>
      <p style="background:#fef2f2;padding:12px;border-radius:4px;">${mission.bonus}</p>

      <h3 style="color:#7c3aed;">🔗 Resource</h3>
      <p><a href="${mission.resource}" style="color:#7c3aed;">${mission.resource}</a></p>

      <hr style="border:1px solid #eee;">
      <p>Good luck, Agent! Report back when your mission is complete. 🚀</p>
    </div>`;

  const subject = 'Coding Saturday - ' + stageInfo.stage + ' - ' + mission.mission + ' - ' + today;
  const result = await sendResendEmailEach([studentEmail, parentEmail], subject, html);
  console.log('[Coding] Email delivered to ' + result.delivered + ' of ' + (result.delivered + result.failed) + ' recipients');
  recordAssignment({
    subject: 'coding',
    title: mission.mission,
    html: html,
    externalUrl: mission.resource || null,
    answerMode: 'text'
  });

  return { missionName: mission.mission, stage: stageInfo.stage, emailSent: true };
}

// =====================================================================
// === AUTONOMOUS WEEKLY PROGRESS REPORT (Sunday) ===
// =====================================================================

async function createAndSendWeeklyReport() {
  const parentEmail = PARENT_EMAIL;
  const studentEmail = STUDENT_EMAIL;
  const today = new Date().toISOString().slice(0, 10);
  const portalUrl = PORTAL_URL;

  const perfData = readPerf('riyansh');

  if (!perfData) {
    // No data at all
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;padding:20px;">
        <h2 style="color:#4f46e5;">📊 Weekly Progress Report — ${today}</h2>
        <p>Hi Vivek,</p>
        <p>Riyansh hasn't used the learning portal this week yet. Please encourage him to complete some quizzes and writing activities!</p>
        <p><a href="${portalUrl}" style="color:#4f46e5;">Open Learning Portal</a></p>
      </div>`;
    const result = await sendResendEmail(parentEmail, 'Weekly Report - ' + today + ' - No activity this week', html);
    return { hasData: false, emailSent: true };
  }

  const progress = perfData.progress || {};

  // Calculate overall stats
  let totalCorrect = 0, totalAttempts = 0;
  const subjectStats = {};
  ['english', 'maths', 'science'].forEach(subj => {
    const topics = progress[subj] || {};
    let sC = 0, sT = 0;
    const topicDetails = [];
    Object.keys(topics).forEach(t => {
      if (t === 'lv') return;
      const d = topics[t];
      const c = d.c || 0, total = d.t || 0;
      sC += c; sT += total;
      if (total > 0) {
        topicDetails.push({ topic: t, correct: c, total, pct: Math.round(c / total * 100) });
      }
    });
    totalCorrect += sC;
    totalAttempts += sT;
    subjectStats[subj] = { correct: sC, total: sT, pct: sT > 0 ? Math.round(sC / sT * 100) : 0, topics: topicDetails };
  });

  // Comp prep stats
  const comp = progress.comp || {};
  let compC = 0, compT = 0;
  const compTopics = [];
  Object.keys(comp).forEach(t => {
    const d = comp[t];
    const c = d.c || 0, total = d.t || 0;
    compC += c; compT += total;
    if (total > 0) compTopics.push({ topic: t, correct: c, total, pct: Math.round(c / total * 100) });
  });

  const overallPct = totalAttempts > 0 ? Math.round(totalCorrect / totalAttempts * 100) : 0;
  const writings = progress.wr || [];
  const streak = perfData.streak || 0;
  const recentDone = (progress.done || []).slice(-10);

  // Identify weak and strong areas
  const allTopics = [];
  Object.keys(subjectStats).forEach(subj => {
    subjectStats[subj].topics.forEach(t => {
      allTopics.push({ subject: subj, ...t });
    });
  });
  const weakAreas = allTopics.filter(t => t.pct < 50 && t.total >= 3).sort((a, b) => a.pct - b.pct).slice(0, 5);
  const strongAreas = allTopics.filter(t => t.pct >= 75 && t.total >= 3).sort((a, b) => b.pct - a.pct).slice(0, 5);

  // Build email
  const subjectRows = Object.keys(subjectStats).map(subj => {
    const s = subjectStats[subj];
    const colour = s.pct >= 70 ? '#16a34a' : s.pct >= 50 ? '#ca8a04' : '#dc2626';
    const topicList = s.topics.map(t => {
      const tc = t.pct >= 70 ? '#16a34a' : t.pct >= 50 ? '#ca8a04' : '#dc2626';
      return t.topic + ': <span style="color:' + tc + ';">' + t.pct + '%</span> (' + t.correct + '/' + t.total + ')';
    }).join(', ');
    return `
      <tr>
        <td style="padding:8px;border:1px solid #ddd;text-transform:capitalize;font-weight:bold;">${subj}</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:center;color:${colour};font-weight:bold;">${s.pct}%</td>
        <td style="padding:8px;border:1px solid #ddd;font-size:13px;">${topicList || 'No data yet'}</td>
      </tr>`;
  }).join('');

  const weakHtml = weakAreas.length > 0
    ? '<ul>' + weakAreas.map(w => '<li style="color:#dc2626;"><strong>' + w.subject + ' → ' + w.topic + '</strong>: ' + w.pct + '% (' + w.correct + '/' + w.total + ')</li>').join('') + '</ul>'
    : '<p style="color:#6b7280;">No significant weak areas identified yet.</p>';

  const strongHtml = strongAreas.length > 0
    ? '<ul>' + strongAreas.map(s => '<li style="color:#16a34a;"><strong>' + s.subject + ' → ' + s.topic + '</strong>: ' + s.pct + '% (' + s.correct + '/' + s.total + ')</li>').join('') + '</ul>'
    : '<p style="color:#6b7280;">Keep practising to build strong areas!</p>';

  const recentHtml = recentDone.length > 0
    ? '<table style="width:100%;border-collapse:collapse;font-size:13px;"><tr style="background:#f9f9f9;"><th style="padding:6px;border:1px solid #ddd;">Date</th><th style="padding:6px;border:1px solid #ddd;">Subject</th><th style="padding:6px;border:1px solid #ddd;">Topic</th><th style="padding:6px;border:1px solid #ddd;">Score</th></tr>' +
      recentDone.reverse().map(d => '<tr><td style="padding:6px;border:1px solid #ddd;">' + (d.date || '—') + '</td><td style="padding:6px;border:1px solid #ddd;text-transform:capitalize;">' + (d.subject || '—') + '</td><td style="padding:6px;border:1px solid #ddd;">' + (d.topic || '—') + '</td><td style="padding:6px;border:1px solid #ddd;">' + (d.score || '—') + '</td></tr>').join('') +
      '</table>'
    : '<p style="color:#6b7280;">No recent quiz data.</p>';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;padding:20px;">
      <h2 style="color:#4f46e5;">📊 Weekly Progress Report — ${today}</h2>
      <p>Hi Vivek,</p>
      <p>Here is Riyansh's learning summary for this week.</p>

      <div style="background:#f0f7ff;padding:15px;border-radius:8px;margin:10px 0;">
        <table style="width:100%;"><tr>
          <td style="text-align:center;"><strong style="font-size:24px;color:#4f46e5;">${overallPct}%</strong><br><span style="font-size:12px;color:#6b7280;">Overall Accuracy</span></td>
          <td style="text-align:center;"><strong style="font-size:24px;color:#4f46e5;">${totalAttempts}</strong><br><span style="font-size:12px;color:#6b7280;">Questions Attempted</span></td>
          <td style="text-align:center;"><strong style="font-size:24px;color:#4f46e5;">${streak}</strong><br><span style="font-size:12px;color:#6b7280;">Day Streak</span></td>
          <td style="text-align:center;"><strong style="font-size:24px;color:#4f46e5;">${writings.length}</strong><br><span style="font-size:12px;color:#6b7280;">Writings Done</span></td>
        </tr></table>
      </div>

      <hr style="border:1px solid #eee;">

      <h3 style="color:#4f46e5;">📚 Subject Breakdown</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr style="background:#f9f9f9;"><th style="padding:8px;border:1px solid #ddd;text-align:left;">Subject</th><th style="padding:8px;border:1px solid #ddd;">Accuracy</th><th style="padding:8px;border:1px solid #ddd;text-align:left;">Topics</th></tr>
        ${subjectRows}
        ${compT > 0 ? '<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Competition Prep</td><td style="padding:8px;border:1px solid #ddd;text-align:center;font-weight:bold;">' + Math.round(compC/compT*100) + '%</td><td style="padding:8px;border:1px solid #ddd;font-size:13px;">' + compTopics.map(t => t.topic + ': ' + t.pct + '%').join(', ') + '</td></tr>' : ''}
      </table>

      <hr style="border:1px solid #eee;">

      <h3 style="color:#dc2626;">⚠️ Areas to Focus On</h3>
      ${weakHtml}

      <h3 style="color:#16a34a;">🌟 Doing Great In</h3>
      ${strongHtml}

      <hr style="border:1px solid #eee;">

      <h3 style="color:#4f46e5;">📝 Recent Activity</h3>
      ${recentHtml}

      <hr style="border:1px solid #eee;">

      <h3 style="color:#4f46e5;">💬 Conversation Starters</h3>
      <ul>
        ${weakAreas.length > 0 ? '<li>"What did you find tricky about ' + weakAreas[0].topic + ' this week?"</li>' : ''}
        ${strongAreas.length > 0 ? '<li>"You did really well in ' + strongAreas[0].topic + '! Can you teach me what you learned?"</li>' : ''}
        <li>"Which science video did you enjoy most this week?"</li>
        <li>"Show me what you built in your coding lesson!"</li>
      </ul>

      <p style="text-align:center;margin-top:15px;">
        <a href="${portalUrl}" style="display:inline-block;background:#4f46e5;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">View Full Portal</a>
      </p>
    </div>`;

  const subject = 'Weekly Report - ' + today + ' - Overall: ' + overallPct + '% accuracy';
  const result = await sendResendEmail(parentEmail, subject, html);
  console.log('[Weekly] Report sent:', result.id || 'ok');
  return { overallPct, totalAttempts, emailSent: true };
}

// =====================================================================
// === ADMIN APIs FOR SCHEDULER ===
// =====================================================================

// Insert scheduler admin routes into the server
const _originalListener = server.listeners('request')[0];
server.removeAllListeners('request');

server.on('request', async (req, res) => {
  const pathOnly = (req.url || '').split('?')[0];

  // --- Scheduler Status ---
  if (pathOnly === '/api/scheduler/status' && req.method === 'GET') {
    const log = readSchedulerLog();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      enabled: schedulerEnabled,
      status: schedulerStatus,
      hasApiKey: !!process.env.RESEND_API_KEY,
      // Diagnostic: shows which env vars the server can actually see.
      // NAMES ONLY — values are never exposed. Helps spot a typo in the
      // variable name, or a variable set on the wrong Railway service.
      envDiagnostic: {
        resendVarsVisible: Object.keys(process.env)
          .filter(k => /resend|mail|smtp/i.test(k))
          .sort(),
        looksLikeTypo: Object.keys(process.env)
          .filter(k => /resend/i.test(k) && k !== 'RESEND_API_KEY' && k !== 'RESEND_FROM'),
        apiKeyLength: process.env.RESEND_API_KEY ? String(process.env.RESEND_API_KEY).length : 0,
        apiKeyLooksValid: /^re_/.test(process.env.RESEND_API_KEY || ''),
        railwayServiceName: process.env.RAILWAY_SERVICE_NAME || null,
        railwayEnvironment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || null,
        totalEnvVars: Object.keys(process.env).length
      },
      emailSender: process.env.RESEND_FROM || 'Riyansh Portal <onboarding@resend.dev>',
      emailWarning: process.env.RESEND_FROM
        ? null
        : 'Using the Resend sandbox sender (onboarding@resend.dev). It can ONLY deliver to the email address that registered the Resend account. Emails to any other recipient (e.g. the student) are rejected with a 403. Fix: verify a domain at resend.com/domains, then set RESEND_FROM to an address on it.',
      questionBankSize: QUESTION_BANK.length,
      schedule: 'Mon/Wed/Fri: Maths | Tue/Thu: Writing | Wed: Science | Sat: Coding | Sun: Report — 7:00 AM HKT',
      nextRun: getNextRunTime().toISOString(),
      recentRuns: (log.runs || []).slice(-10),
      recentErrors: (log.errors || []).slice(-5)
    }));
    return;
  }

  // --- Toggle Scheduler On/Off ---
  // --- Instant Email Test (GET so it can be opened in a browser) ---
  // Sends one short email to each recipient and reports exactly what
  // Resend said, per address. Removes the need to wait for a scheduled run.
  if (pathOnly === '/api/email-test' && req.method === 'GET') {
    const now = Date.now();
    if (now - lastEmailTestAt < 60000) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        error: 'Please wait a minute between tests',
        secondsRemaining: Math.ceil((60000 - (now - lastEmailTestAt)) / 1000)
      }));
      return;
    }
    lastEmailTestAt = now;

    const testHtml = '<div style="font-family:Arial,sans-serif"><h2>Email test</h2>'
      + '<p>If you are reading this, the learning portal can send email successfully.</p>'
      + '<p style="color:#666;font-size:13px">Sent ' + new Date().toISOString() + '</p></div>';

    const recipients = [PARENT_EMAIL, STUDENT_EMAIL];
    const outcome = await sendResendEmailEach(recipients, 'Learning Portal - email test', testHtml);

    const readable = outcome.results.map(r => {
      if (r.ok) return { to: r.to, result: 'DELIVERED to Resend' };
      let meaning = r.error;
      if (/401/.test(r.error)) meaning = 'API KEY INVALID - the key in Railway is not accepted by Resend. Create a new key and update the Railway variable.';
      else if (/RESEND_SANDBOX_LIMIT|403/.test(r.error)) meaning = 'BLOCKED BY SANDBOX - the key works, but onboarding@resend.dev can only reach the Resend account owner. Verify a domain and set RESEND_FROM.';
      else if (/not set/.test(r.error)) meaning = 'NO API KEY - the variable is missing from the running container.';
      return { to: r.to, result: 'FAILED', meaning: meaning };
    });

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({
      testedAt: new Date().toISOString(),
      sender: process.env.RESEND_FROM || 'Riyansh Portal <onboarding@resend.dev>',
      delivered: outcome.delivered,
      failed: outcome.failed,
      recipients: readable
    }, null, 2));
    return;
  }

  if (pathOnly === '/api/scheduler/toggle' && req.method === 'POST') {
    schedulerEnabled = !schedulerEnabled;
    schedulerStatus = schedulerEnabled ? 'active' : 'paused';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ enabled: schedulerEnabled, status: schedulerStatus }));
    return;
  }

  // --- Trigger Assignment Now (manual) ---
  if (pathOnly === '/api/scheduler/trigger' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const result = await createAndSendAssignment();
      const today = new Date().toISOString().slice(0, 10);
      appendSchedulerLog({
        date: today,
        time: new Date().toISOString(),
        success: true,
        manual: true,
        assignmentId: result.assignmentId,
        url: result.url
      });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (e) {
      appendSchedulerError({
        date: new Date().toISOString().slice(0, 10),
        time: new Date().toISOString(),
        error: e.message,
        manual: true
      });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // --- Trigger English Writing Now (manual) ---
  // GET is allowed too so the assignment can be sent on demand by simply
  // opening the URL in a browser — POST needs a tool the user may not have.
  if (pathOnly === '/api/scheduler/trigger-writing' && (req.method === 'POST' || req.method === 'GET')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const result = await createAndSendWritingPrompt();
      appendSchedulerLog({
        date: new Date().toISOString().slice(0, 10),
        time: new Date().toISOString(),
        success: true,
        manual: true,
        type: 'english-writing',
        promptTitle: result.promptTitle,
        level: result.level
      });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (e) {
      appendSchedulerError({
        date: new Date().toISOString().slice(0, 10),
        time: new Date().toISOString(),
        error: e.message,
        manual: true,
        type: 'english-writing'
      });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // --- Trigger Science Now (manual) ---
  if (pathOnly === '/api/scheduler/trigger-science' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const result = await createAndSendScienceEmail();
      appendSchedulerLog({ date: new Date().toISOString().slice(0, 10), time: new Date().toISOString(), success: true, manual: true, type: 'science-video', lessonTitle: result.lessonTitle, topic: result.topic });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (e) {
      appendSchedulerError({ date: new Date().toISOString().slice(0, 10), time: new Date().toISOString(), error: e.message, manual: true, type: 'science-video' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // --- Trigger Coding Now (manual) ---
  if (pathOnly === '/api/scheduler/trigger-coding' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const result = await createAndSendCodingEmail();
      appendSchedulerLog({ date: new Date().toISOString().slice(0, 10), time: new Date().toISOString(), success: true, manual: true, type: 'coding-lesson', missionName: result.missionName, stage: result.stage });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (e) {
      appendSchedulerError({ date: new Date().toISOString().slice(0, 10), time: new Date().toISOString(), error: e.message, manual: true, type: 'coding-lesson' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // --- Trigger Weekly Report Now (manual) ---
  if (pathOnly === '/api/scheduler/trigger-report' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const result = await createAndSendWeeklyReport();
      appendSchedulerLog({ date: new Date().toISOString().slice(0, 10), time: new Date().toISOString(), success: true, manual: true, type: 'weekly-report', overallPct: result.overallPct });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (e) {
      appendSchedulerError({ date: new Date().toISOString().slice(0, 10), time: new Date().toISOString(), error: e.message, manual: true, type: 'weekly-report' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // --- Create Assignment Only (no email, for testing) ---
  if (pathOnly === '/api/scheduler/preview' && req.method === 'GET') {
    const questions = pickQuestions('riyansh', 5);
    const { targetDifficulty } = getAdaptiveDifficulty('riyansh');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      preview: true,
      targetDifficulty: targetDifficulty,
      questions: questions
    }));
    return;
  }

  // --- Scheduler Log ---
  if (pathOnly === '/api/scheduler/log' && req.method === 'GET') {
    const log = readSchedulerLog();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(log));
    return;
  }

  // Fall through to original handler
  _originalListener(req, res);
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('Riyansh Learning Portal running on port ' + PORT);
  console.log('Autonomous scheduler: Mon/Wed/Fri Maths | Tue/Thu Writing | Wed Science | Sat Coding | Sun Report — 7am HKT');
  console.log('Resend API key:', process.env.RESEND_API_KEY ? 'configured' : 'NOT SET (scheduler will wait)');
});
