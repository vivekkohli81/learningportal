const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

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
