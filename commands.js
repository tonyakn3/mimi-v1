export const TURN_COMMANDS = Object.freeze({
  1: Object.freeze({ type: 'SPEAK', phrase: 'Mimi nói' }),
  2: Object.freeze({ type: 'REVERSE', phrase: 'dịch lại' }),
});

export function expectedForSide(side) {
  return TURN_COMMANDS[Number(side) === 2 ? 2 : 1];
}

function normalizeChar(char) {
  const stripped = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /^[a-z0-9]$/.test(stripped) ? stripped : ' ';
}

export function normalizeCommandText(text = '') {
  return Array.from(String(text)).map(normalizeChar).join('').replace(/\s+/g, ' ').trim();
}

function normalizeWithMap(text = '') {
  const raw = String(text);
  let normalized = '';
  const map = [];
  let rawIndex = 0;
  for (const char of raw) {
    const next = normalizeChar(char);
    for (const n of next) {
      normalized += n;
      map.push(rawIndex);
    }
    rawIndex += char.length;
  }
  const collapsed = [];
  const collapsedMap = [];
  let lastSpace = true;
  for (let i = 0; i < normalized.length; i += 1) {
    const c = normalized[i];
    if (c === ' ') {
      if (!lastSpace) {
        collapsed.push(' ');
        collapsedMap.push(map[i]);
        lastSpace = true;
      }
    } else {
      collapsed.push(c);
      collapsedMap.push(map[i]);
      lastSpace = false;
    }
  }
  while (collapsed[0] === ' ') { collapsed.shift(); collapsedMap.shift(); }
  while (collapsed.at(-1) === ' ') { collapsed.pop(); collapsedMap.pop(); }
  return { normalized: collapsed.join(''), map: collapsedMap, raw };
}

export function detectTrailingCommand(text, side) {
  const { normalized, map, raw } = normalizeWithMap(text);
  if (!normalized) return null;

  const regex = Number(side) === 2
    ? /(?:^| )dich lai$/
    : /(?:^| )(?:mimi|mi mi) noi$/;
  const match = normalized.match(regex);
  if (!match) return null;

  const commandStartNorm = match.index + (match[0].startsWith(' ') ? 1 : 0);
  const commandStartRaw = map[commandStartNorm] ?? 0;
  const sourceText = raw.slice(0, commandStartRaw).replace(/[\s,.;:!?…-]+$/u, '').trim();

  return {
    type: Number(side) === 2 ? 'REVERSE' : 'SPEAK',
    phrase: Number(side) === 2 ? 'dịch lại' : 'Mimi nói',
    sourceText,
  };
}

export function stripTrailingCommand(text, side) {
  const found = detectTrailingCommand(text, side);
  return found ? found.sourceText : String(text || '').trim();
}
