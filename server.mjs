import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');
const ALLOWED_MODEL = 'gemini-3.1-flash-live-preview';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const recentRequests = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 24;

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'microphone=(self)',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self' https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com",
      "media-src 'self' blob:",
      "worker-src 'self'",
      "manifest-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    ...extra,
  };
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, securityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  }));
  res.end(body);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function rateLimited(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const list = (recentRequests.get(ip) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (list.length >= RATE_LIMIT) return true;
  list.push(now);
  recentRequests.set(ip, list);
  return false;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Same-origin navigations/server-to-server may omit Origin.
  if (PUBLIC_ORIGIN) return origin === PUBLIC_ORIGIN;
  const host = req.headers.host;
  if (!host) return false;
  return origin === `https://${host}` || origin === `http://${host}`;
}

async function readJsonBody(req, maxBytes = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function createEphemeralToken() {
  const now = Date.now();
  const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now + 60 * 1000).toISOString();

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify({
      uses: 1,
      expireTime,
      newSessionExpireTime,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.name) {
    const details = data?.error?.message || `Gemini auth_tokens HTTP ${response.status}`;
    throw new Error(details);
  }

  return {
    token: data.name,
    expireTime: data.expireTime || expireTime,
    newSessionExpireTime: data.newSessionExpireTime || newSessionExpireTime,
  };
}

async function serveStatic(req, res, pathname) {
  let requested = decodeURIComponent(pathname);
  if (requested === '/') requested = '/index.html';

  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = resolve(PUBLIC_DIR, `.${safePath.startsWith('/') ? safePath : `/${safePath}`}`);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    json(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const info = await stat(filePath);
    const actualPath = info.isDirectory() ? join(filePath, 'index.html') : filePath;
    const data = await readFile(actualPath);
    const ext = extname(actualPath).toLowerCase();
    const immutable = /\/icons\//.test(actualPath);
    res.writeHead(200, securityHeaders({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': immutable ? 'public, max-age=86400' : 'no-cache',
    }));
    res.end(data);
  } catch {
    // SPA/PWA fallback for non-file paths.
    try {
      const index = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, securityHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': index.length,
        'Cache-Control': 'no-cache',
      }));
      res.end(index);
    } catch {
      json(res, 404, { error: 'Not found' });
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const base = `http://${req.headers.host || 'localhost'}`;
    const url = new URL(req.url || '/', base);

    if (url.pathname === '/api/health' && req.method === 'GET') {
      json(res, 200, {
        ok: true,
        apiKeyConfigured: Boolean(GEMINI_API_KEY),
        model: ALLOWED_MODEL,
      });
      return;
    }

    if (url.pathname === '/api/live-token' && req.method === 'POST') {
      if (!originAllowed(req)) {
        json(res, 403, { error: 'Origin không được phép.' });
        return;
      }
      if (rateLimited(req)) {
        json(res, 429, { error: 'Bạn đang tạo quá nhiều phiên. Hãy chờ khoảng một phút rồi thử lại.' });
        return;
      }
      if (!GEMINI_API_KEY) {
        json(res, 503, {
          error: 'Backend chưa có GEMINI_API_KEY. Hãy thêm key vào biến môi trường của server rồi khởi động lại.',
        });
        return;
      }

      const body = await readJsonBody(req);
      if (body.model && body.model !== ALLOWED_MODEL) {
        json(res, 400, { error: 'Model không được phép.' });
        return;
      }

      try {
        const token = await createEphemeralToken();
        json(res, 200, { ...token, model: ALLOWED_MODEL });
      } catch (error) {
        console.error('Ephemeral token error:', error.message);
        json(res, 502, { error: `Không tạo được Gemini token: ${error.message}` });
      }
      return;
    }

    if (!['GET', 'HEAD'].includes(req.method || '')) {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mimi đang chạy tại http://localhost:${PORT}`);
  console.log(`Gemini API key: ${GEMINI_API_KEY ? 'đã cấu hình' : 'CHƯA cấu hình'}`);
});
