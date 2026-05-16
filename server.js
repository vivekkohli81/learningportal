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

  // GET /api/performance/:username - get specific student's performance
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

  // POST /api/performance - save/update student performance
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

  // Serve PWA files
  const STATIC_FILES = {
    '/manifest.json': { file: 'manifest.json', type: 'application/json' },
    '/sw.js': { file: 'sw.js', type: 'application/javascript' },
    '/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
    '/icon-512.png': { file: 'icon-512.png', type: 'image/png' }
  };

  if (STATIC_FILES[req.url]) {
    const sf = STATIC_FILES[req.url];
    const filePath = path.join(__dirname, sf.file);
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': sf.type,
        'Cache-Control': sf.type.includes('javascript') ? 'no-cache' : 'public, max-age=86400'
      });
      res.end(data);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Riyansh Learning Portal running on port ${PORT}`);
});
