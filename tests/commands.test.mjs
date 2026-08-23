import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedForSide, isExactCommandText, normalizeCommandText } from '../public/js/commands.js';

test('side 1 command is Mimi nói', () => assert.equal(expectedForSide(1).phrase, 'Mimi nói'));
test('side 2 command is dịch lại', () => assert.equal(expectedForSide(2).phrase, 'dịch lại'));
test('normalize ignores accents and punctuation', () => assert.equal(normalizeCommandText('Mimi, NÓI!'), 'mimi noi'));
test('side 1 exact command', () => assert.equal(isExactCommandText('Mimi nói', 1), true));
test('side 2 exact command', () => assert.equal(isExactCommandText('dịch lại', 2), true));
test('wrong command is rejected by state', () => assert.equal(isExactCommandText('Mimi nói', 2), false));
