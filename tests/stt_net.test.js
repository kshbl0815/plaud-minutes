import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSegments, wordsToSegments, offsetSegments, transcribeChunk, isHallucination, fmtTime } from '../app/js/stt.js';
import { fetchRetry, RateLimitError, parseRetryAfter } from '../app/js/net.js';
import { startMock } from '../tools/mock-api.js';
import { fileBlob } from './helpers.js';

test('환각 문구/반복 제거', () => {
  const segs = cleanSegments([
    { start: 0, end: 2, text: '예산을 논의합시다' },
    { start: 2, end: 3, text: '시청해주셔서 감사합니다.' },
    { start: 3, end: 4, text: '좋습니다' }, { start: 4, end: 5, text: '좋습니다' }, { start: 5, end: 6, text: '좋습니다' }, { start: 6, end: 7, text: '좋습니다' },
    { start: 7, end: 8, text: '감사합니다.', no_speech_prob: 0.05, avg_logprob: -0.2 },
    { start: 8, end: 9, text: '감사합니다.', no_speech_prob: 0.7, avg_logprob: -0.2 },
  ]);
  assert.deepEqual(segs.map((s) => s.text), ['예산을 논의합시다', '좋습니다', '좋습니다', '감사합니다.']);
  assert.equal(isHallucination({ text: 'MBC 뉴스 이덕영입니다' }), true);
});

test('xAI 단어 → 화자별 세그먼트, 오프셋', () => {
  const s = wordsToSegments([
    { text: '안녕하세요', start: 0, end: 0.5, speaker: 0 }, { text: '반갑습니다.', start: 0.6, end: 1, speaker: 0 },
    { text: '네', start: 1.2, end: 1.4, speaker: 1 }, { text: '시작하죠', start: 5, end: 5.5, speaker: 1 },
  ]);
  assert.equal(s.length, 3);
  assert.equal(s[0].text, '안녕하세요 반갑습니다.');
  assert.equal(s[1].speaker, 1);
  assert.equal(offsetSegments(s, 600)[2].start, 605);
  assert.equal(fmtTime(3725), '1:02:05');
});

test('Groq 형식 요청: 필드/파일 순서, 응답 파싱 + 환각 제거', async () => {
  const mock = await startMock();
  try {
    const blob = await fileBlob('short.mp3', 'audio/mpeg');
    const r = await transcribeChunk({ provider: 'groq', apiKey: 'gsk_test', baseUrl: `http://127.0.0.1:${mock.port}/openai/v1`, model: 'whisper-large-v3', keyterms: ['플라우드'], prevText: '이전 문장' }, blob, 'short.mp3');
    assert.ok(r.segments.length >= 6);
    assert.ok(!r.segments.some((s) => s.text.includes('시청')));
    const l = mock.log.at(-1);
    assert.equal(l.fields.language, 'ko'); assert.equal(l.fields.response_format, 'verbose_json');
    assert.ok(l.fields.prompt.includes('플라우드') && l.fields.prompt.includes('이전 문장'));
    assert.equal(l.order.at(-1), 'file');
  } finally { mock.server.close(); }
});

test('xAI 형식 요청: diarize/keyterm, file 마지막', async () => {
  const mock = await startMock();
  try {
    const r = await transcribeChunk({ provider: 'xai', apiKey: 'xai-test', baseUrl: `http://127.0.0.1:${mock.port}/xai/v1`, keyterms: ['OKR', '베타'] }, await fileBlob('short.mp3'), 'short.mp3');
    const l = mock.log.at(-1);
    assert.equal(l.path, '/xai/v1/stt'); assert.equal(l.fields.diarize, 'true'); assert.deepEqual(l.fields.keyterm, ['OKR', '베타']);
    assert.equal(l.order.at(-1), 'file');
    assert.ok(r.segments.length >= 6); assert.ok(r.segments.some((s) => s.speaker === 1));
  } finally { mock.server.close(); }
});

test('429 재시도 / 긴 대기는 일시정지(RateLimitError) / 401 메시지', async () => {
  const mock = await startMock();
  const base = `http://127.0.0.1:${mock.port}/openai/v1`;
  try {
    mock.cfg.fail429 = 2;
    const waits = [];
    const r = await transcribeChunk({ provider: 'groq', apiKey: 'k', baseUrl: base }, await fileBlob('short.mp3'), 'a.mp3', { onWait: (w) => waits.push(w) });
    assert.equal(waits.length, 2); assert.ok(r.segments.length > 0);
    mock.cfg.fail429 = 1; mock.cfg.bigWait = true;
    await assert.rejects(transcribeChunk({ provider: 'groq', apiKey: 'k', baseUrl: base }, await fileBlob('short.mp3'), 'a.mp3'), (e) => e instanceof RateLimitError && e.waitSec === 3600);
    await assert.rejects(transcribeChunk({ provider: 'groq', apiKey: 'bad', baseUrl: base }, await fileBlob('short.mp3'), 'a.mp3'), /인증 실패/);
    await assert.rejects(transcribeChunk({ provider: 'groq', apiKey: '', baseUrl: base }, await fileBlob('short.mp3'), 'a.mp3'), /API 키가 설정되지/);
  } finally { mock.server.close(); }
});

test('Groq reset 헤더 파싱', () => {
  const h = (o) => ({ headers: new Headers(o) });
  assert.equal(parseRetryAfter(h({ 'retry-after': '12' })), 12);
  assert.equal(Math.round(parseRetryAfter(h({ 'x-ratelimit-reset-audio-seconds': '2m59.5s' }))), 180);
  assert.equal(parseRetryAfter(h({})), null);
});
