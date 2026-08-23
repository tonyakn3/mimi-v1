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
const COMMAND_MODEL = 'gemini-3.1-flash-lite';

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
const recentCommandRequests = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 24;
const COMMAND_RATE_LIMIT = 120;

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

function commandRateLimited(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const list = (recentCommandRequests.get(ip) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (list.length >= COMMAND_RATE_LIMIT) return true;
  list.push(now);
  recentCommandRequests.set(ip, list);
  return false;
}

function pcm16ToWav(pcmBuffer, sampleRate = 16000) {
  const dataLength = pcmBuffer.length;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataLength, 40);
  pcmBuffer.copy(wav, 44);
  return wav;
}

async function detectCommandFromPcm(base64Pcm, sampleRate = 16000) {
  const raw = Buffer.from(base64Pcm, 'base64');
  if (raw.length < 1600) return 'NONE';

  // The wake phrase is always at the end. Keep only the last ~3.2 seconds so
  // detection stays fast even when the source utterance was long.
  const maxBytes = Math.floor(sampleRate * 2 * 3.2);
  const tail = raw.length > maxBytes ? raw.subarray(raw.length - maxBytes) : raw;
  const wav = pcm16ToWav(tail, sampleRate);

  const prompt = [
    'You are a strict Vietnamese voice-command recognizer for an interpreter app named Mimi.',
    'Listen to the END of this short audio.',
    'Output exactly one token and nothing else:',
    'SPEAK = the speaker clearly says the Vietnamese command "Mimi nói".',
    'TRANSLATE = the speaker clearly says the Vietnamese command "Mimi dịch".',
    'NONE = neither command is clearly spoken.',
    'Audio before the command may be Chinese or another language.',
    'Do not translate. Do not infer a command from context.',
    'Recognize natural Vietnamese pronunciation and mild background noise.'
  ].join('\n');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${COMMAND_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
          ],
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8,
        },
      }),
    },
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = data?.error?.message || `Gemini command classifier HTTP ${response.status}`;
    throw new Error(details);
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part?.text || '')
    .join(' ')
    .trim()
    .toUpperCase();

  if (text.includes('TRANSLATE')) return 'TRANSLATE';
  if (text.includes('SPEAK')) return 'SPEAK';
  return 'NONE';
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

    if (url.pathname === '/api/detect-command' && req.method === 'POST') {
      if (!originAllowed(req)) {
        json(res, 403, { error: 'Origin không được phép.' });
        return;
      }
      if (commandRateLimited(req)) {
        json(res, 429, { error: 'Command detector đang nhận quá nhiều yêu cầu.' });
        return;
      }
      if (!GEMINI_API_KEY) {
        json(res, 503, { error: 'Backend chưa có GEMINI_API_KEY.' });
        return;
      }

      try {
        const body = await readJsonBody(req, 700_000);
        const audio = String(body.audio || '');
        const sampleRate = Number(body.sampleRate || 16000);
        if (!audio || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
          json(res, 400, { error: 'Audio command không hợp lệ.' });
          return;
        }
        const command = await detectCommandFromPcm(audio, sampleRate);
        json(res, 200, { command });
      } catch (error) {
        console.error('Command detector error:', error.message);
        json(res, 502, { error: `Không nhận diện được câu lệnh: ${error.message}` });
      }
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
