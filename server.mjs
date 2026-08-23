import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');
const LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const COMMAND_MODEL = 'gemini-3.5-flash-lite';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'microphone=(self)',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; base-uri 'self'; frame-ancestors 'none'",
    ...extra,
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }));
  res.end(body);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (PUBLIC_ORIGIN) return origin === PUBLIC_ORIGIN;
  const host = req.headers.host;
  return Boolean(host && (origin === `https://${host}` || origin === `http://${host}`));
}

async function readJsonBody(req, maxBytes = 1_200_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function pcm16ToWav(pcmBuffer, sampleRate = 16000) {
  const dataLength = pcmBuffer.length - (pcmBuffer.length % 2);
  const wav = Buffer.alloc(44 + dataLength);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataLength, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataLength, 40); pcmBuffer.copy(wav, 44, 0, dataLength);
  return wav;
}

async function createEphemeralToken() {
  const now = Date.now();
  const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now + 60 * 1000).toISOString();
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.name) throw new Error(data?.error?.message || `Gemini auth token HTTP ${response.status}`);
  return { token: data.name, expireTime: data.expireTime || expireTime, model: LIVE_MODEL };
}

async function detectCommandAudio({ audio, sampleRate, expected }) {
  const pcm = Buffer.from(String(audio || ''), 'base64');
  if (pcm.length < 1000) return false;
  const rate = Number(sampleRate || 16000);
  if (!Number.isFinite(rate) || rate < 8000 || rate > 48000) throw new Error('INVALID_SAMPLE_RATE');
  const maxBytes = Math.floor(rate * 2 * 3.4);
  const tail = pcm.length > maxBytes ? pcm.subarray(pcm.length - maxBytes) : pcm;
  const phrase = expected === 'REVERSE' ? 'dịch lại' : 'Mimi nói';
  const prompt = [
    'You are a strict Vietnamese voice-command classifier.',
    `The expected command is exactly: "${phrase}".`,
    'Judge ONLY the supplied short audio utterance.',
    'Return YES only if that utterance is essentially the command itself, allowing normal Southern Vietnamese pronunciation, punctuation, and tiny recognition variations.',
    'Return NO if it is ordinary conversation, if more meaningful words follow the command, or if the phrase is merely discussed.',
    'Output exactly YES or NO and nothing else.'
  ].join('\n');
  const wav = pcm16ToWav(tail, rate);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${COMMAND_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] }],
      generationConfig: { maxOutputTokens: 4 },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Gemini command HTTP ${response.status}`);
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || '').join(' ').trim().toUpperCase();
  return text.startsWith('YES');
}

async function serveStatic(req, res, pathname) {
  let requested = decodeURIComponent(pathname);
  if (requested === '/') requested = '/index.html';
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = resolve(PUBLIC_DIR, `.${safePath.startsWith('/') ? safePath : `/${safePath}`}`);
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });
  try {
    const info = await stat(filePath);
    const actual = info.isDirectory() ? join(filePath, 'index.html') : filePath;
    const data = await readFile(actual);
    const ext = extname(actual).toLowerCase();
    const immutable = /\/icons\//.test(actual);
    res.writeHead(200, securityHeaders({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': immutable ? 'public, max-age=86400' : 'no-cache, no-store, must-revalidate',
    }));
    res.end(data);
  } catch {
    const index = await readFile(join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, securityHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': index.length, 'Cache-Control': 'no-cache, no-store, must-revalidate' }));
    res.end(index);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, version: '2.1.0', apiKeyConfigured: Boolean(GEMINI_API_KEY), liveModel: LIVE_MODEL, commandModel: COMMAND_MODEL });
    }
    if (url.pathname.startsWith('/api/') && !originAllowed(req)) return json(res, 403, { error: 'Origin không được phép.' });
    if (url.pathname.startsWith('/api/') && !GEMINI_API_KEY) return json(res, 503, { error: 'Backend chưa có GEMINI_API_KEY.' });

    if (url.pathname === '/api/live-token' && req.method === 'POST') {
      try { return json(res, 200, await createEphemeralToken()); }
      catch (error) { console.error('live-token:', error.message); return json(res, 502, { error: `Không tạo được Live token: ${error.message}` }); }
    }

    if (url.pathname === '/api/detect-command' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 900_000);
        const expected = body.expected === 'REVERSE' ? 'REVERSE' : 'SPEAK';
        const detected = await detectCommandAudio({ audio: body.audio, sampleRate: body.sampleRate, expected });
        return json(res, 200, { detected, expected, phrase: expected === 'REVERSE' ? 'dịch lại' : 'Mimi nói' });
      } catch (error) {
        console.error('detect-command:', error.message);
        return json(res, 502, { error: `Không nhận diện được câu lệnh: ${error.message}` });
      }
    }

    if (!['GET', 'HEAD'].includes(req.method || '')) return json(res, 405, { error: 'Method not allowed' });
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mimi V2.1 Hot Live đang chạy tại http://localhost:${PORT}`);
  console.log(`Gemini API key: ${GEMINI_API_KEY ? 'đã cấu hình' : 'CHƯA cấu hình'}`);
  console.log(`Live model: ${LIVE_MODEL} | Command fallback: ${COMMAND_MODEL}`);
});
