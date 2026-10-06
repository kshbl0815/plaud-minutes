// 엔드투엔드(노드): 30분 MP3 → 분할 → 가짜 Groq 전사(청크마다 ffprobe 검증) → 가짜 LLM 회의록
import test from 'node:test';
import assert from 'node:assert/strict';
import { processMeeting } from '../app/js/pipeline.js';
import { startMock } from '../tools/mock-api.js';
import { fileBlob } from './helpers.js';
import { search } from '../app/js/search.js';

function memStore(blob) {
  const saved = [];
  return { saved, getAudio: async () => blob, save: async (m) => { saved.push(JSON.parse(JSON.stringify({ status: m.status, step: m.step }))); }, existingTags: async () => ['예산'] };
}

test('전체 파이프라인 + 레이트리밋 일시정지 후 재개(완료 청크 건너뜀)', async () => {
  const mock = await startMock();
  try {
    const base = `http://127.0.0.1:${mock.port}`;
    const cfg = {
      stt: { provider: 'groq', apiKey: 'gsk', baseUrl: `${base}/openai/v1`, model: 'whisper-large-v3', language: 'ko', keyterms: [], limits: { maxBytes: 24 * 1024 * 1024, maxSec: 600 } },
      llm: { provider: 'gemini', apiKey: 'g', baseUrl: `${base}/gemini/v1beta/openai`, model: 'gemini-3.8-flash' },
    };
    const blob = await fileBlob('long.mp3', 'audio/mpeg');
    const m = { id: 'e2e', title: '2026-10-06 녹음', fileName: 'long.mp3', mime: 'audio/mpeg', size: blob.size, date: '2026-10-06T05:00:00Z', status: 'imported', tags: [] };
    const store = memStore(blob);

    // 2번째 청크에서 긴 대기 429 → paused
    let calls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { if (String(url).includes('/audio/transcriptions') && ++calls === 2) { mock.cfg.fail429 = 1; mock.cfg.bigWait = true; } return origFetch(url, init); };
    await assert.rejects(processMeeting(m, store, cfg));
    globalThis.fetch = origFetch;
    assert.equal(m.status, 'paused');
    assert.ok(m.resumeAt > Date.now() + 3000 * 1000);
    assert.equal(m.chunkResults.filter(Boolean).length, 1);
    mock.cfg.bigWait = false;

    const before = mock.log.filter((l) => l.path.endsWith('/audio/transcriptions') && l.status === 200).length;
    await processMeeting(m, store, cfg);
    const sttOk = mock.log.filter((l) => l.path.endsWith('/audio/transcriptions') && l.status === 200);
    assert.equal(sttOk.length - before, 2, '재개 시 남은 2개 청크만 전송');
    assert.ok(sttOk.every((l) => l.size <= 24 * 1024 * 1024 && l.duration <= 618));
    assert.equal(m.status, 'done');
    assert.equal(m.title, '분기 예산 및 출시 일정 회의');
    assert.deepEqual(m.tags, ['예산', '제품 출시']);
    assert.ok(Math.abs(m.durationSec - 1800) < 1);
    // 타임스탬프 단조 증가, 청크 오프셋 적용, 환각 제거
    for (let i = 1; i < m.segments.length; i++) assert.ok(m.segments[i].start >= m.segments[i - 1].start);
    assert.ok(m.segments.at(-1).start > 1700);
    assert.ok(!m.segments.some((s) => s.text.includes('시청')));
    assert.match(m.minutesMd, /예산 검토/);
    assert.equal(search([m], '출시 일정').length, 1);
    // 프롬프트에 기존 태그 전달
    const chatLog = mock.log.filter((l) => l.path.endsWith('/chat/completions'));
    assert.ok(chatLog.length >= 1);
  } finally { mock.server.close(); }
});

test('xAI 프로바이더: 30분 파일을 분할 없이 한 번에 + 화자', async () => {
  const mock = await startMock();
  try {
    const base = `http://127.0.0.1:${mock.port}`;
    const cfg = {
      stt: { provider: 'xai', apiKey: 'x', baseUrl: `${base}/xai/v1`, model: 'grok-voice-transcribe-2.0', language: 'ko', diarize: true, keyterms: [], limits: { maxBytes: 480 * 1024 * 1024, maxSec: 0 } },
      llm: { provider: 'xai', apiKey: 'x', baseUrl: `${base}/xai/v1`, model: 'grok-4.3' },
    };
    const blob = await fileBlob('long.mp3', 'audio/mpeg');
    const m = { id: 'x1', title: 't', fileName: 'long.mp3', mime: 'audio/mpeg', status: 'imported', tags: [] };
    await processMeeting(m, memStore(blob), cfg);
    const stt = mock.log.filter((l) => l.path === '/xai/v1/stt');
    assert.equal(stt.length, 1);
    assert.equal(m.status, 'done');
    assert.ok(m.segments.some((s) => s.speaker === 1));
  } finally { mock.server.close(); }
});
