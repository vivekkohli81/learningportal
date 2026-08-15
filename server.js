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

  // === COMPETITION PREP ASSIGNMENTS DATABASE ===
const COMP_PREP_DIR = path.join(DATA_ROOT, 'comp-prep');
if (!fs.existsSync(COMP_PREP_DIR)) fs.mkdirSync(COMP_PREP_DIR, { recursive: true });
const COMP_PREP_FILES_DIR = path.join(COMP_PREP_DIR, 'uploads');
if (!fs.existsSync(COMP_PREP_FILES_DIR)) fs.mkdirSync(COMP_PREP_FILES_DIR, { recursive: true });

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

server.listen(PORT, '0.0.0.0', function() {
  console.log('Riyansh Learning Portal running on port ' + PORT);
});
