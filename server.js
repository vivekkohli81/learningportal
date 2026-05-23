const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const writingSubmitHtml = fs.readFileSync(path.join(__dirname, 'writing-submit.html'), 'utf8');

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

// === PERFORMANCE DATABASE ===
const PERF_DIR = path.join(DATA_ROOT, 'data');
if (!fs.existsSync(PERF_DIR)) fs.mkdirSync(PERF_DIR, { recursive: true });

// === QUIZ RESULTS DATABASE ===
const QUIZ_DIR = path.join(DATA_ROOT, 'quiz-results');
if (!fs.existsSync(QUIZ_DIR)) fs.mkdirSync(QUIZ_DIR, { recursive: true });

// === WRITING SUBMISSIONS DATABASE ===
const WRITING_DIR = path.join(DATA_ROOT, 'writing-submissions');
if (!fs.existsSync(WRITING_DIR)) fs.mkdirSync(WRITING_DIR, { recursive: true });

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
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getSyncPath(username) {
  const safe = username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  return path.join(SYNC_DIR, safe + '.json');
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
      body.lastSyncDate = new Date().toISOString();
      const fp = getSyncPath(body.username);
      fs.writeFileSync(fp, JSON.stringify(body, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, username: body.username, lastSyncDate: body.lastSyncDate }));
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
        checklist: body.checklist || []
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
