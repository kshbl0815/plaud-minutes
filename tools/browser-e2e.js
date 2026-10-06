// 헤드리스 Chrome E2E: 실제 브라우저에서 IndexedDB/분할(디코딩 포함)/서비스워커 공유 대상/UI 검증 (가짜 API 사용)
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { startMock } from './mock-api.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FIX = path.join(ROOT, 'tests/fixtures');
const OUT = path.join(ROOT, 'tests/screens');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg) => { if (!c) throw new Error('FAIL: ' + msg); console.log('✔', msg); };

const srv = spawn('node', [path.join(ROOT, 'tools/serve.js'), path.join(ROOT, 'app'), '8090'], { stdio: 'inherit' });
const mock = await startMock(8788);
await sleep(500);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:8090/', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: `${OUT}/01-empty.png` });

  // 설정: 가짜 API로 지정 (UI 입력과 같은 저장 함수 사용)
  await page.evaluate(async () => {
    const S = await import('./js/settings.js');
    const s = await S.loadSettings();
    s.sttProvider = 'groq'; s.llmProvider = 'gemini';
    s.stt.groq = { baseUrl: 'http://127.0.0.1:8788/openai/v1', chunkMin: 1, model: 'whisper-large-v3' };
    s.llm.gemini = { baseUrl: 'http://127.0.0.1:8788/gemini/v1beta/openai', model: 'gemini-3.8-flash' };
    await S.saveSettings(s);
    await S.saveKeys({ groq: 'gsk_fake', gemini: 'AIza_fake' });
  });
  await page.goto('http://localhost:8090/#/settings', { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(500);
  ok(await page.$eval('#k_groq', (e) => e.value) === 'gsk_fake', '암호화 저장된 API 키 복호화/표시');
  await page.screenshot({ path: `${OUT}/02-settings.png`, fullPage: true });

  // 파일 가져오기: m4a(디코딩→WAV 분할 경로) + 30분 mp3(프레임 분할 경로)
  await page.goto('http://localhost:8090/#/import', { waitUntil: 'networkidle0' });
  const input = await page.$('#file');
  await input.uploadFile(path.join(FIX, 'short.m4a'), path.join(FIX, 'long.mp3'));
  const t0 = Date.now();
  let ms = [];
  while (Date.now() - t0 < 120000) {
    ms = await page.evaluate(() => window.__pm.meetings().map((m) => ({ id: m.id, status: m.status, step: m.step, error: m.error, n: m.segments?.length, title: m.title, chunks: m.chunkTotal })));
    if (ms.length === 2 && ms.every((m) => ['done', 'error'].includes(m.status))) break;
    await sleep(1000);
  }
  console.log(ms);
  ok(ms.length === 2 && ms.every((m) => m.status === 'done'), '두 파일 모두 전사+회의록 완료');
  const stt = mock.log.filter((l) => l.path.endsWith('/audio/transcriptions'));
  ok(stt.filter((l) => l.filename.endsWith('.wav')).length === 2, 'm4a(95초) → 브라우저 디코딩 후 16kHz WAV 2청크(1분 설정)');
  ok(stt.filter((l) => l.filename.endsWith('.mp3')).length === 30, '30분 mp3 → 1분 청크 30개 (MP3 프레임 분할, 재인코딩 없음)');
  ok(stt.every((l) => l.status === 200), '모든 청크가 디코딩 가능(ffprobe 통과)');

  // 목록 + 검색
  await page.goto('http://localhost:8090/#/', { waitUntil: 'networkidle0' });
  await sleep(400);
  await page.screenshot({ path: `${OUT}/03-list.png` });
  await page.goto('http://localhost:8090/#/?q=' + encodeURIComponent('출시 일정'), { waitUntil: 'networkidle0' });
  await sleep(400);
  const hits = await page.$$eval('.mcard', (els) => els.length);
  ok(hits === 2, `검색 "출시 일정" 결과 ${hits}건`);
  ok(await page.$('.snip mark') !== null, '검색 스니펫 하이라이트');
  await page.screenshot({ path: `${OUT}/04-search.png` });

  // 상세
  const id = ms[0].id;
  await page.goto(`http://localhost:8090/#/m/${id}`, { waitUntil: 'networkidle0' });
  await sleep(600);
  ok(await page.$('#audio') !== null, '오디오 플레이어');
  ok((await page.$$('.topic')).length === 2, '주제별 섹션 2개 표시');
  await page.screenshot({ path: `${OUT}/05-detail.png`, fullPage: true });
  await page.goto(`http://localhost:8090/#/m/${id}?tab=transcript`, { waitUntil: 'networkidle0' });
  await sleep(500);
  ok((await page.$$('.seg')).length > 0, '전사본 탭 (타임스탬프 클릭 재생)');
  await page.screenshot({ path: `${OUT}/06-transcript.png` });

  // 편집 (제목/태그)
  await page.goto(`http://localhost:8090/#/m/${id}`, { waitUntil: 'networkidle0' });
  await sleep(400);
  await page.$eval('#edit', (b) => b.click());
  await page.$eval('#eTitle', (e) => (e.value = '수정된 제목'));
  await page.$eval('#eTags', (e) => (e.value = '예산, 마케팅'));
  await page.$eval('#eSave', (b) => b.click());
  await sleep(600);
  const edited = await page.evaluate((id) => window.__pm.meetings().find((m) => m.id === id), id);
  ok(edited.title === '수정된 제목' && edited.tags.includes('마케팅') && edited.titleEdited, '제목/태그 편집 저장');

  // 주제 보기 + 종합 요약
  await page.goto('http://localhost:8090/#/topics', { waitUntil: 'networkidle0' });
  await sleep(400);
  await page.screenshot({ path: `${OUT}/07-topics.png` });
  await page.goto('http://localhost:8090/#/topic/' + encodeURIComponent('예산'), { waitUntil: 'networkidle0' });
  await sleep(400);
  await page.$eval('#roll', (b) => b.click());
  await page.waitForFunction(() => document.body.innerText.includes('누적 결정사항'), { timeout: 15000 });
  ok(true, '주제별 종합 요약 생성/저장');
  await page.screenshot({ path: `${OUT}/08-topic-rollup.png`, fullPage: true });

  // Web Share Target: 서비스워커가 POST를 받아 inbox에 저장 → 앱이 가져옴
  await page.goto('http://localhost:8090/', { waitUntil: 'networkidle0' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'networkidle0' });
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  ok(controlled, '서비스워커 제어 중');
  const shareRes = await page.evaluate(async () => {
    const b = await (await fetch('icons/icon-192.png')).blob(); // 아무 바이트 (가짜 오디오)
    const fd = new FormData();
    fd.append('audio', new File([b], '2026-10-07 09_15_00.mp3', { type: 'audio/mpeg' }));
    const r = await fetch('./share-target', { method: 'POST', body: fd });
    return { url: r.url, redirected: r.redirected };
  });
  ok(shareRes.redirected && shareRes.url.includes('index') || shareRes.url.endsWith('/'), `공유 POST → 리다이렉트 (${shareRes.url})`);
  await page.evaluate(async () => { const S = await import('./js/settings.js'); const s = await S.loadSettings(); s.autoProcess = false; await S.saveSettings(s); });
  await page.goto('http://localhost:8090/#/import?shared=1', { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(800);
  const shared = await page.evaluate(() => window.__pm.meetings().find((m) => m.fileName === '2026-10-07 09_15_00.mp3'));
  ok(!!shared, '공유받은 파일이 보관함에 추가됨');
  ok(shared.date === '2026-10-07T00:15:00.000Z', '파일명에서 녹음 일시(KST) 추출');
  await page.screenshot({ path: `${OUT}/09-import.png` });

  // PC 레이아웃
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://localhost:8090/#/', { waitUntil: 'networkidle0' });
  await sleep(400);
  await page.screenshot({ path: `${OUT}/10-desktop.png` });

  const realErrors = errors.filter((e) => !/favicon|ERR_FAILED|404/.test(e));
  console.log('console errors:', realErrors);
  ok(realErrors.length === 0, '콘솔 오류 없음');
  console.log('BROWSER E2E PASSED');
} finally {
  await browser.close();
  mock.server.close();
  srv.kill();
}
