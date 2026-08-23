const COMMAND_PATTERNS = [
  { type: 'SPEAK', regex: /\bmi\s*mi\s*[,.:;\-–—]?\s*n(?:o|ó)i\b/iu },
  { type: 'TRANSLATE', regex: /\bmi\s*mi\s*[,.:;\-–—]?\s*d(?:i|ị)ch\b/iu },
];

function normalizeForCommand(text = '') {
  return text
    .toLocaleLowerCase('vi-VN')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectMimiCommand(text = '') {
  const original = String(text);

  for (const item of COMMAND_PATTERNS) {
    const match = item.regex.exec(original);
    if (match) {
      return {
        type: item.type,
        index: match.index,
        matchedText: match[0],
        sourceText: original.slice(0, match.index).trim(),
      };
    }
  }

  // Fallback for STT that drops Vietnamese accents or inserts unusual spacing.
  const normalized = normalizeForCommand(original);
  const candidates = [
    { type: 'SPEAK', phrases: ['mimi noi', 'mi mi noi'] },
    { type: 'TRANSLATE', phrases: ['mimi dich', 'mi mi dich'] },
  ];

  for (const candidate of candidates) {
    if (candidate.phrases.some((phrase) => normalized.includes(phrase))) {
      return {
        type: candidate.type,
        index: -1,
        matchedText: '',
        sourceText: stripCommandFallback(original),
      };
    }
  }

  return null;
}

export function stripCommandFallback(text = '') {
  return String(text)
    .replace(/\bmi\s*mi\s*[,.:;\-–—]?\s*(?:n(?:o|ó)i|d(?:i|ị)ch)\b[\s\S]*$/iu, '')
    .trim();
}

export function mergeTranscript(buffer = '', incoming = '', lastChunk = '') {
  const current = String(buffer).trim();
  const next = String(incoming).trim();
  const previous = String(lastChunk).trim();

  if (!next) return { buffer: current, lastChunk: previous };
  if (!previous) {
    return { buffer: current ? `${current} ${next}`.trim() : next, lastChunk: next };
  }

  const nNext = normalizeForCommand(next);
  const nPrev = normalizeForCommand(previous);

  if (nNext === nPrev || nPrev.startsWith(nNext)) {
    return { buffer: current, lastChunk: previous };
  }

  if (nNext.startsWith(nPrev) && current.endsWith(previous)) {
    return {
      buffer: `${current.slice(0, -previous.length)}${next}`.trim(),
      lastChunk: next,
    };
  }

  return {
    buffer: current ? `${current} ${next}`.trim() : next,
    lastChunk: next,
  };
}
