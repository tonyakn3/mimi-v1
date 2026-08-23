import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMimiCommand, mergeTranscript } from '../public/js/commands.js';

test('detects Mimi nói', () => {
  const result = detectMimiCommand('Giá này cao lắm. Mimi nói');
  assert.equal(result.type, 'SPEAK');
  assert.equal(result.sourceText, 'Giá này cao lắm.');
});

test('detects Mi Mi dịch', () => {
  const result = detectMimiCommand('这个价格太高了。 Mi Mi dịch');
  assert.equal(result.type, 'TRANSLATE');
  assert.match(result.sourceText, /这个价格太高了/);
});

test('detects commands without accents', () => {
  assert.equal(detectMimiCommand('an trua khong mimi noi').type, 'SPEAK');
  assert.equal(detectMimiCommand('你好 mimi dich').type, 'TRANSLATE');
});

test('merges growing partial transcript', () => {
  let state = mergeTranscript('', 'Giá này', '');
  state = mergeTranscript(state.buffer, 'Giá này cao lắm', state.lastChunk);
  assert.equal(state.buffer, 'Giá này cao lắm');
});

test('reverse direction survives out-of-order transcription: command arrives before Chinese source', () => {
  const result = detectMimiCommand('Mimi dịch 这个价格太高了。');
  assert.equal(result.type, 'TRANSLATE');
  assert.match(result.sourceText, /这个价格太高了/);
});

test('accepts common STT variant Mimi Dick for Mimi dịch', () => {
  const result = detectMimiCommand('这个价格太高了。 Mimi Dick');
  assert.equal(result.type, 'TRANSLATE');
  assert.match(result.sourceText, /这个价格太高了/);
});
