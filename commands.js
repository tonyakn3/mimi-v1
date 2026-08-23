const TRAILING_COMMANDS = [
  {
    type: 'SPEAK',
    // Command must be at the end. This deliberately does NOT match
    // "Mimi nói chuyện..." or any phrase with meaningful words after it.
    regex: /(?:^|[\s.!?…,:;\-–—])mi\s*mi\s*[,.:;\-–—]?\s*n(?:o|ó)i\s*[.!?…,:;\-–—]*\s*$/iu,
  },
  {
    type: 'TRANSLATE',
    regex: /(?:^|[\s.!?…,:;\-–—])mi\s*mi\s*[,.:;\-–—]?\s*(?:d(?:i|ị)ch|dich|dick|dict|dik)\s*[.!?…,:;\-–—]*\s*$/iu,
  },
];

function normalizeForCommand(text = '') {
  return String(text)
    .toLocaleLowerCase('vi-VN')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSourceText(text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

function trailingNormalizedCommand(normalized = '') {
  const candidates = [
    { type: 'SPEAK', phrases: ['mimi noi', 'mi mi noi'] },
    { type: 'TRANSLATE', phrases: ['mimi dich', 'mi mi dich', 'mimi dick', 'mi mi dick', 'mimi dict', 'mi mi dict', 'mimi dik', 'mi mi dik'] },
  ];

  for (const candidate of candidates) {
    for (const phrase of candidate.phrases) {
      if (normalized === phrase || normalized.endsWith(` ${phrase}`)) {
        return { type: candidate.type, phrase };
      }
    }
  }
  return null;
}

function stripTrailingKnownCommand(text = '') {
  let output = String(text);
  for (const item of TRAILING_COMMANDS) {
    const match = item.regex.exec(output);
    if (!match) continue;
    output = output.slice(0, match.index).trim();
    return cleanSourceText(output);
  }

  // Normalized fallback: remove only an end command. Never remove a phrase from
  // the middle of ordinary content, which prevents accidental app activation.
  const normalized = normalizeForCommand(output);
  const hit = trailingNormalizedCommand(normalized);
  if (!hit) return cleanSourceText(output);

  // Text fallback cannot safely map normalized character positions back to the
  // original string. Use a conservative raw suffix matcher for known STT forms.
  return cleanSourceText(output.replace(
    /(?:^|[\s.!?…,:;\-–—])mi\s*mi\s*[,.:;\-–—]?\s*(?:n(?:o|ó)i|d(?:i|ị)ch|dich|dick|dict|dik)\s*[.!?…,:;\-–—]*\s*$/iu,
    ' ',
  ));
}

export function detectMimiCommand(text = '') {
  const original = String(text);

  for (const item of TRAILING_COMMANDS) {
    const match = item.regex.exec(original);
    if (match) {
      return {
        type: item.type,
        index: match.index,
        matchedText: match[0].trim(),
        sourceText: cleanSourceText(original.slice(0, match.index)),
      };
    }
  }

  return null;
}

// Used after an audio command has already been positively confirmed. Still only
// strips a trailing command so ordinary discussion containing "Mimi dịch" is kept.
export function stripCommandFallback(text = '') {
  return stripTrailingKnownCommand(text);
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
