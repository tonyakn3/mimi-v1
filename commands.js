export const TURN_COMMANDS = Object.freeze({
  1: Object.freeze({ type: 'SPEAK', phrase: 'Mimi nói', sourceLabel: 'Người 1', targetLabel: 'Người 2' }),
  2: Object.freeze({ type: 'REVERSE', phrase: 'dịch lại', sourceLabel: 'Người 2', targetLabel: 'Người 1' }),
});

export function expectedForSide(side) {
  return TURN_COMMANDS[Number(side) === 2 ? 2 : 1];
}

export function normalizeCommandText(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isExactCommandText(text, side) {
  const expected = normalizeCommandText(expectedForSide(side).phrase);
  return normalizeCommandText(text) === expected;
}
