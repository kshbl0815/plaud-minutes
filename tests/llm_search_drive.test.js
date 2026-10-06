import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, normalizeMinutes, splitTranscript, generateMinutes, generateTopicRollup, chat } from '../app/js/llm.js';
import { minutesToMarkdown, mdToHtml, exportMarkdown } from '../app/js/minutes.js';
import { search, tagCounts, parseQuery } from '../app/js/search.js';
import { planSync, mergeRemote, mergeTopics } from '../app/js/drive.js';
import { startMock } from '../tools/mock-api.js';

test('JSON 추출 (코드펜스/앞뒤 잡음)', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('결과: {"a":{"b":2}} 끝'), { a: { b: 2 } });
  assert.throws(() => extractJson('없음'));
});

test('회의록 정규화: 문자열 액션아이템, 태그 수집', () => {
  const m = normalizeMinutes({ title: 'T', topics: [{ name: '예산', tag: '#예산', action_items: ['보고서 작성'] }], tags: ['기획'] });
  assert.equal(m.topics[0].tag, '예산');
  assert.deepEqual(m.action_items, [{ owner: '', task: '보고서 작성', due: '' }]);
  assert.deepEqual(m.tags, ['기획', '예산']);
});

test('긴 전사본 분할은 줄 경계 유지', () => {
  const t = Array.from({ length: 100 }, (_, i) => `[00:${String(i).padStart(2, '0')}] 문장 ${i}`).join('\n');
  const parts = splitTranscript(t, 300);
  assert.ok(parts.length > 3);
  assert.equal(parts.join('\n'), t);
  assert.ok(parts.every((p) => p.length <= 300));
});

const meeting = () => ({ id: 'm1', title: '녹음 001', fileName: 'rec.mp3', date: '2026-10-06T05:30:00.000Z', durationSec: 600, tags: [],
  segments: Array.from({ length: 40 }, (_, i) => ({ start: i * 15, end: i * 15 + 14, text: `${i}번 발언: 예산안을 검토하고 출시 일정을 조율합니다.` })) });

test('회의록 생성: 단일 요청 + 파트 분할(map-reduce) + response_format 폴백', async () => {
  const mock = await startMock();
  const cfg = { provider: 'xai', apiKey: 'k', baseUrl: `http://127.0.0.1:${mock.port}/xai/v1`, model: 'grok-4.3' };
  try {
    const m = meeting();
    const mm = await generateMinutes(cfg, m, ['예산']);
    assert.equal(mm.topics.length, 2); assert.equal(mock.log.filter((l) => l.path.endsWith('/chat/completions')).length, 1);
    assert.equal(mock.log.at(-1).response_format.type, 'json_object');
    const steps = [];
    await generateMinutes({ ...cfg, maxInputChars: 800 }, m, [], { onStep: (s) => steps.push(s) });
    assert.ok(steps.some((s) => s.includes('통합')));
    mock.cfg.rejectResponseFormat = true;
    const mm2 = await generateMinutes(cfg, m, []);
    assert.equal(mm2.title, '분기 예산 및 출시 일정 회의');
    m.minutes = mm; m.title = mm.title; m.tags = mm.tags; m.minutesMd = minutesToMarkdown(m);
    assert.match(m.minutesMd, /## 주제별 논의/); assert.match(m.minutesMd, /- \[ \] 김성훈 — 예산안 작성 \(기한: 10\/10\)/);
    assert.match(exportMarkdown(m), /## 전사본/);
    const roll = await generateTopicRollup(cfg, '예산', [m]);
    assert.match(roll, /누적 결정사항/);
  } finally { mock.server.close(); }
});

test('마크다운 → HTML은 스크립트를 이스케이프', () => {
  const h = mdToHtml('## 제목\n- <script>alert(1)</script> **굵게**');
  assert.ok(!h.includes('<script>')); assert.ok(h.includes('<b>굵게</b>')); assert.ok(h.includes('<h3>제목</h3>'));
});

test('한국어 검색: 조사 붙은 단어, 구문, 제외어, 태그 필터, 스니펫', () => {
  const ms = [
    { id: 'a', title: '마케팅 회의', date: '2026-10-01', tags: ['마케팅'], minutesMd: '광고 예산안을 확정했다', segments: [{ start: 0, end: 1, text: '유튜브 광고비를 늘립시다' }] },
    { id: 'b', title: '개발 주간회의', date: '2026-10-02', tags: ['개발'], minutesMd: '출시 일정 지연', segments: [{ start: 0, end: 1, text: '예산은 다음에 이야기하죠' }] },
    { id: 'c', title: '삭제됨', deleted: true, tags: [], segments: [] },
  ];
  assert.deepEqual(search(ms, '예산').map((r) => r.meeting.id), ['a', 'b']); // a: 회의록 가중치 > b: 전사본
  assert.deepEqual(search(ms, '예산 -광고').map((r) => r.meeting.id), ['b']);
  assert.deepEqual(search(ms, '"출시 일정"').map((r) => r.meeting.id), ['b']);
  assert.deepEqual(search(ms, '', { tag: '개발' }).map((r) => r.meeting.id), ['b']);
  assert.match(search(ms, '광고비')[0].snippet, /<mark>광고비<\/mark>/);
  assert.deepEqual(tagCounts(ms), [['개발', 1], ['마케팅', 1]]);
  assert.deepEqual(parseQuery('A "b c" -d'), [{ t: 'a', neg: false }, { t: 'b c', neg: false }, { t: 'd', neg: true }]);
});

test('Drive 동기화 계획: 업로드/다운로드/오디오/삭제표시', () => {
  const local = [
    { id: 'x', updatedAt: 200, audioLocal: true },              // 원격보다 최신 → push, 오디오 없음 → pushAudio
    { id: 'y', updatedAt: 100, audioLocal: true },              // 원격이 최신 → pull
    { id: 'z', updatedAt: 300, audioLocal: true, deleted: true }, // 삭제 표시 push, 오디오 업로드 안 함
  ];
  const remote = [
    { id: 'Fx', name: 'm_x.json', appProperties: { updatedAt: '150' } },
    { id: 'Fy', name: 'm_y.json', appProperties: { updatedAt: '180' } },
    { id: 'Ay', name: 'a_y.mp3' },
    { id: 'Fw', name: 'm_w.json', appProperties: { updatedAt: '50' } }, // 다른 기기에서 만든 회의 → pull
    { id: 'T', name: 'topics.json' },
  ];
  const p = planSync(local, remote);
  assert.deepEqual(p.pushJson, ['x', 'z']);
  assert.deepEqual(p.pushAudio, ['x']);
  assert.deepEqual(p.pull, [{ id: 'y', fileId: 'Fy' }, { id: 'w', fileId: 'Fw' }]);
  assert.equal(p.remoteAudio.y, 'Ay');
  const merged = mergeRemote({ audioLocal: true, drive: { audioId: 'A' } }, { id: 'y', title: 'R', drive: { jsonId: 'J' } });
  assert.equal(merged.audioLocal, true); assert.deepEqual(merged.drive, { audioId: 'A', jsonId: 'J' });
  assert.deepEqual(mergeTopics([{ tag: 'a', updatedAt: 5 }], [{ tag: 'a', updatedAt: 9 }, { tag: 'b', updatedAt: 1 }]).map((t) => t.updatedAt), [9, 1]);
});
