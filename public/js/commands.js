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

function globalize(regex) {
  const flags = new Set(regex.flags.split(''));
  flags.add('g');
  return new RegExp(regex.source, [...flags].join(''));
}

function cleanSourceText(text = '') {
  return String(text)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove a Mimi command wherever it appears in the transcript, while keeping
 * source speech that may arrive before OR after it.
 *
 * Gemini input transcription is asynchronous. In a bilingual turn it may
 * return the Vietnamese command "Mimi dịch" before the partner's Chinese
 * transcript even though the Chinese was spoken first. Keeping text on both
 * sides of the command prevents the reverse direction from losing the source.
 */
function removeCommandAnywhere(text = '', regex) {
  return cleanSourceText(String(text).replace(globalize(regex), ' '));
}

function stripKnownCommandAnywhere(text = '') {
  // Covers normal Vietnamese plus common STT variants such as "Mimi Dick".
  return cleanSourceText(String(text).replace(
    /\bmi\s*mi\s*[,.:;\-–—]?\s*(?:n(?:o|ó)i|d(?:i|ị)ch|dich|dick|dict|dik)\b/giu,
    ' ',
  ));
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
        sourceText: removeCommandAnywhere(original, item.regex),
      };
    }
  }

  // Fallback for STT that drops Vietnamese accents, inserts unusual spacing,
  // or hears "dịch" as an English-looking "dick/dict/dik" token.
  const normalized = normalizeForCommand(original);
  const candidates = [
    { type: 'SPEAK', phrases: ['mimi noi', 'mi mi noi'] },
    { type: 'TRANSLATE', phrases: ['mimi dich', 'mi mi dich', 'mimi dick', 'mi mi dick', 'mimi dict', 'mi mi dict', 'mimi dik', 'mi mi dik'] },
  ];

  for (const candidate of candidates) {
    if (candidate.phrases.some((phrase) => normalized.includes(phrase))) {
      return {
        type: candidate.type,
        index: -1,
        matchedText: '',
        sourceText: stripKnownCommandAnywhere(original),
      };
    }
  }

  return null;
}

// Kept for backward compatibility with tests/imports from older builds.
export function stripCommandFallback(text = '') {
  return stripKnownCommandAnywhere(text);
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
