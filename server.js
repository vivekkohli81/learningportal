const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// === PERFORMANCE DATABASE ===
// Simple JSON file-based storage for student performance data
const PERF_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(PERF_DIR)) fs.mkdirSync(PERF_DIR, { recursive: true });

// === QUIZ RESULTS DATABASE ===
const QUIZ_DIR = path.join(__dirname, 'quiz-results');
if (!fs.existsSync(QUIZ_DIR)) fs.mkdirSync(QUIZ_DIR, { recursive: true });

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
const SYNC_DIR = path.join(__dirname, 'sync');
if (!fs.existsSync(SYNC_DIR)) fs.mkdirSync(SYNC_DIR, { recursive: true });

// === ACCOUNTS DATABASE ===
const ACCOUNTS_FILE = path.join(__dirname, 'sync', 'accounts.json');

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
  // Sanitize username to prevent path traversal
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

// Helper: read full request body
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// Helper: proxy a request to an external API
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
      // Extract the full Gemini URL from query parameter
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

  // POST /api/quiz-results - save a quiz result
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

      // Also update performance data with latest quiz info
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

  // GET /api/quiz-results/:username - get all quiz results for a student
  if (req.url.startsWith('/api/quiz-results/') && req.method === 'GET') {
    const username = decodeURIComponent(req.url.split('/api/quiz-results/')[1]).split('?')[0];
    const data = readQuizResults(username);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
    return;
  }

  // === ACCOUNTS SYNC API ===

  // POST /api/accounts - upload accounts (admin + kids list)
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

  // GET /api/accounts - download accounts
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

  // === FULL PROGRESS SYNC API (two-way cross-device sync) ===

  // POST /api/sync - upload full progress
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

  // GET /api/sync/:username - download full progress
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

  // GET /api/performance - list all students' performance summaries
  if (req.url === '/api/performance' && req.method === 'GET') {
    const all = listAllPerf();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(all));
    return;
  }

  // G