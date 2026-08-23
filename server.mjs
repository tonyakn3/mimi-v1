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
// Stable, low-latency multimodal model used only for recognizing the two fixed
// Vietnamese commands and, when needed, recovering the source transcript.
const COMMAND_MODEL = 'gemini-3.5-flash-lite';

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

const recentTokenRequests = new Map();
const recentCommandRequests = new Map();
const RATE_WINDOW_MS = 60_000;
const TOKEN_RATE_LIMIT = 24;
const COMMAND_RATE_LIMIT = 90;

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

function isRateLimited(store, req, limit) {
  const ip = getClientIp(req);
  const now = Date.now();
  const list = (store.get(ip) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (list.length >= limit) return true;
  list.push(now);
  store.set(ip, list);
  return false;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
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

function pcm16ToWav(pcmBuffer, sampleRate = 16000) {
  const dataLength = pcmBuffer.length - (pcmBuffer.length % 2);
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
  pcmBuffer.copy(wav, 44, 0, dataLength);
  return wav;
}

function validateAudioPayload(body) {
  const audio = String(body.audio || '');
  const sampleRate = Number(body.sampleRate || 16000);
  if (!audio || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
    throw new Error('INVALID_AUDIO');
  }
  return { audio, sampleRate };
}

function commandPhrase(expected) {
  return expected === 'TRANSLATE' ? 'Mimi dịch' : 'Mimi nói';
}

function normalizeExpected(expected) {
  return expected === 'TRANSLATE' ? 'TRANSLATE' : 'SPEAK';
}

async function geminiGenerate({ model, prompt, wav, generationConfig }) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
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
        ...(generationConfig ? { generationConfig } : {}),
      }),
    },
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = data?.error?.message || `Gemini HTTP ${response.status}`;
    throw new Error(details);
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part?.text || '')
    .join(' ')
    .trim();

  return text;
}

async function detectExpectedCommandFromPcm(base64Pcm, sampleRate = 16000, expected = 'SPEAK') {
  const raw = Buffer.from(base64Pcm, 'base64');
  if (raw.length < 1000) return false;

  // Only the tail matters because the command is always spoken after the source.
  // 4.8 seconds is intentionally generous for natural/slow Vietnamese speech.
  const maxBytes = Math.floor(sampleRate * 2 * 4.8);
  const tail = raw.length > maxBytes ? raw.subarray(raw.length - maxBytes) : raw;
  const wav = pcm16ToWav(tail, sampleRate);
  const expectedPhrase = commandPhrase(expected);

  const prompt = [
    'You are a strict Vietnamese fixed-command detector for an interpreter app named Mimi.',
    `Expected command: "${expectedPhrase}".`,
    'Listen specifically to the END of this audio.',
    `Return HIT only if the speaker actually says "${expectedPhrase}" as the app command near the end.`,
    'Return NONE otherwise.',
    'The audio before it may be Chinese, Vietnamese, English, mixed technical speech, music from another device, or room noise.',
    'Accept natural Southern Vietnamese pronunciation, normal speaking speed, mild clipping, mild noise, and small pauses between Mimi and the last word.',
    'Do not require perfect transcription. Judge the sound of the command.',
    'Do not infer the command from context.',
    'Output exactly HIT or NONE and nothing else.',
  ].join('\n');

  const text = await geminiGenerate({ model: COMMAND_MODEL, prompt, wav });
  return /^HIT\b/i.test(text);
}

async function resolveTurnFromPcm(base64Pcm, sampleRate = 16000, expected = 'SPEAK', sourceLanguage = '') {
  const raw = Buffer.from(base64Pcm, 'base64');
  if (raw.length < 1000) return { commandDetected: false, sourceText: '' };

  // The client keeps the complete current turn until translation finishes.
  const wav = pcm16ToWav(raw, sampleRate);
  const expectedPhrase = commandPhrase(expected);
  const prompt = [
    'You are recovering one turn for a professional two-person interpreter app.',
    `The source language is ${sourceLanguage || 'the language spoken before the command'}.`,
    `The only valid trailing app command for this turn is the Vietnamese phrase "${expectedPhrase}".`,
    `Determine whether "${expectedPhrase}" is actually spoken near the END of the audio.`,
    'If it is present, transcribe ALL source speech that came before that command, faithfully and in its ORIGINAL language.',
    'Remove only the app command itself. Do not translate the source.',
    'Preserve numbers, prices, currencies, dimensions, model numbers, brands, product codes, English technical terms and mixed-language terms exactly when audible.',
    'Ignore room noise and the Mimi app voice if any residual echo exists.',
    'If no valid trailing command is present, commandDetected must be false.',
    'If the command is present but the source is empty, sourceText may be empty.',
    'Return JSON matching the provided schema only.',
  ].join('\n');

  const text = await geminiGenerate({
    model: COMMAND_MODEL,
    prompt,
    wav,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          commandDetected: { type: 'BOOLEAN' },
          sourceText: { type: 'STRING' },
        },
        required: ['commandDetected', 'sourceText'],
      },
    },
  });

  try {
    const parsed = JSON.parse(text);
    return {
      commandDetected: Boolean(parsed.commandDetected),
      sourceText: String(parsed.sourceText || '').replace(/\s+/g, ' ').trim(),
    };
  } catch {
    throw new Error('Gemini trả dữ liệu resolver không hợp lệ.');
  }
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
      'Cache-Control': immutable ? 'public, max-age=86400' : 'no-cache, no-store, must-revalidate',
    }));
    res.end(data);
  } catch {
    try {
      const index = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, securityHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': index.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
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
        version: '1.7.3',
        apiKeyConfigured: Boolean(GEMINI_API_KEY),
        liveModel: LIVE_MODEL,
        commandModel: COMMAND_MODEL,
      });
      return;
    }

    if (url.pathname === '/api/detect-command' && req.method === 'POST') {
      if (!originAllowed(req)) {
        json(res, 403, { error: 'Origin không được phép.' });
        return;
      }
      if (isRateLimited(recentCommandRequests, req, COMMAND_RATE_LIMIT)) {
        json(res, 429, { error: 'Command detector đang nhận quá nhiều yêu cầu.' });
        return;
      }
      if (!GEMINI_API_KEY) {
        json(res, 503, { error: 'Backend chưa có GEMINI_API_KEY.' });
        return;
      }

      try {
        const body = await readJsonBody(req, 900_000);
        const { audio, sampleRate } = validateAudioPayload(body);
        const expected = normalizeExpected(body.expected);
        const hit = await detectExpectedCommandFromPcm(audio, sampleRate, expected);
        json(res, 200, { command: hit ? expected : 'NONE' });
      } catch (error) {
        console.error('Command detector error:', error.message);
        json(res, 502, { error: `Không nhận diện được câu lệnh: ${error.message}` });
      }
      return;
    }

    if (url.pathname === '/api/resolve-turn' && req.method === 'POST') {
      if (!originAllowed(req)) {
        json(res, 403, { error: 'Origin không được phép.' });
        return;
      }
      if (isRateLimited(recentCommandRequests, req, COMMAND_RATE_LIMIT)) {
        json(res, 429, { error: 'Turn resolver đang nhận quá nhiều yêu cầu.' });
        return;
      }
      if (!GEMINI_API_KEY) {
        json(res, 503, { error: 'Backend chưa có GEMINI_API_KEY.' });
        return;
      }

      try {
        const body = await readJsonBody(req, 32_000_000);
        const { audio, sampleRate } = validateAudioPayload(body);
        const expected = normalizeExpected(body.expected);
        const sourceLanguage = String(body.sourceLanguage || '').slice(0, 120);
        const result = await resolveTurnFromPcm(audio, sampleRate, expected, sourceLanguage);
        json(res, 200, result);
      } catch (error) {
        console.error('Turn resolver error:', error.message);
        json(res, 502, { error: `Không chốt được câu nguồn: ${error.message}` });
      }
      return;
    }

    if (url.pathname === '/api/live-token' && req.method === 'POST') {
      if (!originAllowed(req)) {
        json(res, 403, { error: 'Origin không được phép.' });
        return;
      }
      if (isRateLimited(recentTokenRequests, req, TOKEN_RATE_LIMIT)) {
        json(res, 429, { error: 'Bạn đang tạo quá nhiều phiên. Hãy chờ khoảng một phút rồi thử lại.' });
        return;
      }
      if (!GEMINI_API_KEY) {
        json(res, 503, {
          error: 'Backend chưa có GEMINI_API_KEY. Hãy thêm key vào Environment Variables của Render.',
        });
        return;
      }

      const body = await readJsonBody(req);
      if (body.model && body.model !== LIVE_MODEL) {
        json(res, 400, { error: 'Model không được phép.' });
        return;
      }

      try {
        const token = await createEphemeralToken();
        json(res, 200, { ...token, model: LIVE_MODEL });
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
  console.log(`Mimi V1.7 đang chạy tại http://localhost:${PORT}`);
  console.log(`Gemini API key: ${GEMINI_API_KEY ? 'đã cấu hình' : 'CHƯA cấu hình'}`);
  console.log(`Live model: ${LIVE_MODEL} | Command model: ${COMMAND_MODEL}`);
});
