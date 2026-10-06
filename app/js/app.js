// UI (프레임워크 없이: 해시 라우팅 + 템플릿 문자열)
import { db, kvGet, kvSet, newId, saveMeeting } from './db.js';
import { loadSettings, saveSettings, loadKeys, saveKeys, sttConfig, llmConfig, PRESETS } from './settings.js';
import { STT_PROVIDERS, fmtTime, speakerName, transcriptText } from './stt.js';
import { LLM_PROVIDERS, generateTopicRollup, askArchive } from './llm.js';
import { processMeeting } from './pipeline.js';
import { esc, minutesToMarkdown, exportMarkdown, mdToHtml } from './minutes.js';
import { search, tagCounts, highlight, parseQuery } from './search.js';
import * as drive from './drive.js';
import { syncNow, fetchAudioFromDrive, saveSettingsToDrive, loadSettingsFromDrive } from './sync.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');
let meetings = [];
let settings, keys;
const STATUS = { imported: ['대기', ''], transcribing: ['음성 인식 중', 'run'], transcribed: ['전사 완료', 'run'], summarizing: ['회의록 작성 중', 'run'], done: ['완료', 'done'], error: ['오류', 'err'], paused: ['한도 대기', 'pause'] };

// ---------------- 공통 ----------------
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
async function reload() { meetings = (await db.all('meetings')).filter((m) => !m.deleted); }
const visible = () => meetings.filter((m) => !m.deleted);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const badge = (m) => { const [l, c] = STATUS[m.status] || [m.status, '']; return `<span class="badge ${c}">${esc(l)}</span>`; };
const prog = (m) => (['transcribing', 'summarizing'].includes(m.status) ? `<div class="prog"><i style="width:${Math.round((m.progress || 0) * 100)}%"></i></div><div class="meta">${esc(m.step || '')}</div>` : m.status === 'error' || m.status === 'paused' ? `<div class="meta" style="color:var(--err)">${esc(m.error || '')}</div>` : '');
function download(name, text, type = 'text/markdown') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const safeName = (s) => String(s || 'meeting').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

/** 파일명에서 날짜 추출: 2026-10-06 14_30, 20261006_143012, 2026.10.06 등 */
export function dateFromName(name) {
  const m = String(name).match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ _T-]?(\d{2})[-_:.]?(\d{2})(?:[-_:.]?(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59) return null;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`).toISOString();
}

// ---------------- 가져오기 ----------------
async function importFile(file) {
  const name = file.name || `녹음_${new Date().toISOString().slice(0, 16)}.mp3`;
  const dup = visible().find((m) => m.fileName === name && m.size === file.size);
  if (dup) { toast(`이미 가져온 파일입니다: ${name}`); return dup; }
  const id = newId();
  const m = {
    id, title: name.replace(/\.[^.]+$/, ''), fileName: name, mime: file.type || '', size: file.size,
    date: dateFromName(name) || new Date(file.lastModified || Date.now()).toISOString(),
    createdAt: Date.now(), status: 'imported', tags: [], audioLocal: true, drive: {},
  };
  await db.put('audio', { id, blob: file });
  await saveMeeting(m);
  meetings.unshift(m);
  if (settings.autoProcess) {
    if (sttConfig(settings, keys).apiKey && llmConfig(settings, keys).apiKey) enqueue(id);
    else toast('설정에서 API 키를 입력한 뒤, 회의 화면에서 ▶ 버튼을 눌러 처리하세요', 5000);
  }
  return m;
}
async function drainInbox() {
  const items = await db.all('inbox');
  for (const it of items) {
    const f = new File([it.blob], it.name, { type: it.type || it.blob.type, lastModified: it.lastModified });
    await importFile(f);
    await db.del('inbox', it.id);
  }
  if (items.length) toast(`공유받은 녹음 ${items.length}개를 가져왔습니다`);
  return items.length;
}

// ---------------- 처리 큐 ----------------
const queue = [];
let working = false, abortCtl = null, wakeLock = null;
function enqueue(id) { if (!queue.includes(id)) queue.push(id); pump(); }
async function pump() {
  if (working) return;
  const id = queue.shift();
  if (!id) { releaseWake(); return; }
  working = true;
  const m = meetings.find((x) => x.id === id) || (await db.get('meetings', id));
  if (!m || m.deleted) { working = false; return pump(); }
  try {
    settings = await loadSettings(); keys = await loadKeys();
    const cfg = { stt: sttConfig(settings, keys), llm: llmConfig(settings, keys) };
    await acquireWake();
    abortCtl = new AbortController();
    const store = {
      getAudio: async (mid) => (await db.get('audio', mid))?.blob,
      save: (mm) => saveMeeting(mm),
      existingTags: async () => tagCounts(visible()).map(([t]) => t),
    };
    await processMeeting(m, store, cfg, onProgress, { signal: abortCtl.signal });
    if (m.status === 'done') { notify(`회의록 완성: ${m.title}`); autoSync(); }
  } catch (e) {
    console.error(e);
    if (m?.status === 'paused' && m.resumeAt) setTimeout(() => enqueue(m.id), Math.max(5000, m.resumeAt - Date.now()));
    else toast(`처리 실패: ${e.message}`, 5000);
  } finally {
    working = false; abortCtl = null;
    onProgress(m);
    pump();
  }
}
function onProgress(m) {
  const i = meetings.findIndex((x) => x.id === m.id);
  if (i >= 0) meetings[i] = m;
  const el = $(`[data-mid="${m.id}"] .stat`);
  if (el) el.innerHTML = `${badge(m)}${prog(m)}`;
  if (location.hash.startsWith(`#/m/${m.id}`) && ['done', 'transcribed', 'error', 'paused'].includes(m.status) && !$('[data-editing]')) route();
}
async function acquireWake() { try { if (!wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
function releaseWake() { try { wakeLock?.release(); } catch {} wakeLock = null; }
async function notify(msg) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration();
  reg ? reg.showNotification('Plaud 회의록', { body: msg, icon: 'icons/icon-192.png' }) : new Notification('Plaud 회의록', { body: msg });
}

// ---------------- 동기화 ----------------
function setSync(s) { $('#syncStatus').textContent = s; }
async function autoSync() {
  if (!settings.autoSync || !drive.hasToken()) return;
  runSync(false);
}
async function runSync(interactive) {
  try {
    if (!drive.hasToken()) {
      if (!interactive) return;
      await drive.connect(settings.driveClientId);
    }
    const r = await syncNow(settings, (s) => setSync(s ? `☁️ ${s}` : ''));
    await reload();
    setSync(`☁️ 동기화됨 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`);
    if (interactive) toast(`동기화 완료 (받음 ${r.pulled}, 올림 ${r.pushed}, 오디오 ${r.audioUp})`);
    if (!location.hash.startsWith('#/settings')) route();
  } catch (e) {
    setSync('☁️ 동기화 실패');
    toast(e.message, 5000);
  }
}
let syncTimer;
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(autoSync, 4000); }

// ---------------- 화면: 목록 ----------------
function qparams() { return new URLSearchParams(location.hash.split('?')[1] || ''); }
function renderList() {
  const p = qparams();
  const q = p.get('q') || '', tag = p.get('tag') || '';
  const tags = tagCounts(visible()).slice(0, 30);
  const res = search(visible(), q, { tag: tag || null });
  if (!q) res.sort((a, b) => (b.meeting.date || '').localeCompare(a.meeting.date || ''));
  view.innerHTML = `
    <div class="searchbar"><input id="q" type="search" placeholder="회의록·전사본 전체 검색 (예: 예산 \"출시 일정\" -잡담)" value="${esc(q)}"><button id="ask" title="보관함에 AI로 질문">💬</button></div>
    ${tags.length ? `<div class="chips">${tag ? `<a class="chip" href="#/${q ? `?q=${encodeURIComponent(q)}` : ''}">✕ 필터 해제</a>` : ''}${tags.map(([t, n]) => `<span class="chip ${t === tag ? 'on' : ''}" data-tag="${esc(t)}">#${esc(t)}<span class="n">${n}</span></span>`).join('')}</div>` : ''}
    <div class="meta">${q || tag ? `검색 결과 ${res.length}건` : `전체 ${res.length}건`}</div>
    <div id="answer"></div>
    ${res.length ? res.map(({ meeting: m, snippet }) => `
      <a class="card mcard" data-mid="${m.id}" href="#/m/${m.id}${q ? `?q=${encodeURIComponent(q)}` : ''}">
        <div class="row"><h3 class="grow">${q ? highlight(m.title, parseQuery(q).map((x) => x.t)) : esc(m.title)}</h3></div>
        <div class="meta">${fmtDate(m.date)}${m.durationSec ? ` · ${fmtTime(m.durationSec)}` : ''}${!m.audioLocal && m.drive?.audioId ? ' · ☁️' : ''}</div>
        <div class="stat">${badge(m)}${prog(m)}</div>
        ${m.tags?.length ? `<div class="chips">${m.tags.map((t) => `<span class="chip">#${esc(t)}</span>`).join('')}</div>` : ''}
        ${snippet ? `<div class="snip">${snippet}</div>` : m.minutes?.overall_summary ? `<div class="snip">${esc(m.minutes.overall_summary.slice(0, 140))}${m.minutes.overall_summary.length > 140 ? '…' : ''}</div>` : ''}
      </a>`).join('') : `<div class="empty">${q || tag ? '검색 결과가 없습니다.' : '아직 회의록이 없습니다.<br>Plaud 앱에서 녹음을 <b>공유 → 회의록</b>으로 보내거나<br>아래 ➕ 가져오기에서 파일을 선택하세요.'}</div>`}
    <a class="btn pri fab" href="#/import">➕ 녹음 추가</a>`;
  const qi = $('#q');
  let t;
  qi.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { const np = new URLSearchParams(); if (qi.value) np.set('q', qi.value); if (tag) np.set('tag', tag); history.replaceState(null, '', `#/${np.toString() ? `?${np}` : ''}`); renderList(); const n = $('#q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); });
  $$('[data-tag]').forEach((c) => c.addEventListener('click', () => { const np = new URLSearchParams(); if (q) np.set('q', q); if (c.dataset.tag !== tag) np.set('tag', c.dataset.tag); location.hash = `#/?${np}`; }));
  $('#ask').addEventListener('click', () => askDialog());
}

async function askDialog() {
  const qs = prompt('보관함 전체에 질문하세요 (예: 지난달 마케팅 회의에서 결정된 예산은?)');
  if (!qs) return;
  const box = $('#answer');
  box.innerHTML = `<div class="card">⏳ 답변 생성 중…</div>`;
  try {
    const terms = qs.replace(/[?？.,!]/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
    const scored = visible().filter((m) => m.minutesMd).map((m) => {
      const hay = `${m.title} ${(m.tags || []).join(' ')} ${m.minutesMd}`.toLowerCase();
      return { m, s: terms.reduce((a, w) => a + (hay.includes(w.toLowerCase().slice(0, Math.max(2, w.length - 1))) ? 1 : 0), 0) };
    }).sort((a, b) => b.s - a.s || (b.m.date || '').localeCompare(a.m.date || ''));
    const ans = await askArchive(llmConfig(settings, keys), qs, scored.slice(0, 25).map((x) => x.m));
    box.innerHTML = `<div class="card minutes"><div class="meta">💬 ${esc(qs)}</div>${mdToHtml(ans)}</div>`;
  } catch (e) { box.innerHTML = `<div class="card" style="color:var(--err)">${esc(e.message)}</div>`; }
}

// ---------------- 화면: 가져오기 ----------------
function renderImport() {
  const p = qparams();
  const recent = visible().slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 15);
  view.innerHTML = `
    ${p.get('shareError') ? `<div class="card" style="color:var(--err)">공유 받기 실패: ${esc(p.get('shareError'))}</div>` : ''}
    <div class="card">
      <h3 style="margin-top:0">녹음 가져오기</h3>
      <div id="drop" class="drop">여기에 오디오 파일을 끌어다 놓거나<br><br><label class="btn pri" style="display:inline-flex;color:#fff">📂 파일 선택<input id="file" type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.opus,.aac,.flac,video/mp4" multiple hidden></label></div>
      <p class="help">MP3·WAV·M4A·OGG·FLAC 지원. 여러 개 동시 선택 가능. ${settings.autoProcess ? '가져오면 자동으로 전사·회의록 작성이 시작됩니다.' : '자동 처리가 꺼져 있습니다(설정).'}</p>
    </div>
    <details class="card"><summary>📱 Plaud 앱에서 바로 보내는 방법</summary>
      <ol class="help">
        <li>이 앱을 휴대폰 Chrome에서 열고 메뉴(⋮) → <b>앱 설치</b>(홈 화면에 추가)를 한 번 해 둡니다.</li>
        <li>Plaud 앱에서 녹음 파일을 열고 오른쪽 위 아이콘 → <b>Export as file(파일로 내보내기)</b> → <b>Audio</b> → <b>MP3</b>를 선택합니다.</li>
        <li>공유 시트에서 <b>회의록</b> 앱을 고르면 자동으로 가져와 처리합니다.</li>
        <li>공유 목록에 안 보이면: 파일을 '다운로드'에 저장한 뒤 위의 <b>파일 선택</b>을 쓰세요.</li>
      </ol>
      <p class="help">Plaud Note Pro는 USB 파일 접근을 지원하지 않으므로(충전 전용) Plaud 앱 내보내기가 공식 경로입니다.</p>
    </details>
    <h3>최근 가져온 녹음</h3>
    ${recent.map((m) => `<a class="card mcard" data-mid="${m.id}" href="#/m/${m.id}"><b>${esc(m.title)}</b><div class="meta">${esc(m.fileName || '')} · ${(m.size / 1048576 || 0).toFixed(1)}MB</div><div class="stat">${badge(m)}${prog(m)}</div></a>`).join('') || '<div class="empty">없음</div>'}`;
  const input = $('#file');
  input.addEventListener('change', async () => { await handleFiles([...input.files]); input.value = ''; });
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => { e.preventDefault(); drop.classList.remove('over'); await handleFiles([...e.dataTransfer.files]); });
}
async function handleFiles(files) {
  files = files.filter((f) => /^audio\/|^video\/mp4/.test(f.type) || /\.(mp3|wav|m4a|ogg|opus|aac|flac|mp4|webm)$/i.test(f.name));
  if (!files.length) return toast('오디오 파일이 아닙니다');
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  for (const f of files) await importFile(f);
  toast(`${files.length}개 가져옴`);
  if (files.length === 1) location.hash = `#/m/${meetings[0].id}`; else route();
}

// ---------------- 화면: 회의 상세 ----------------
let audioUrl = null;
async function renderDetail(id) {
  const m = meetings.find((x) => x.id === id) || (await db.get('meetings', id));
  if (!m || m.deleted) { view.innerHTML = '<div class="empty">회의를 찾을 수 없습니다</div>'; return; }
  const q = qparams().get('q') || '';
  const terms = parseQuery(q).map((x) => x.t);
  const tab = qparams().get('tab') || (m.minutes ? 'minutes' : 'transcript');
  const a = await db.get('audio', id);
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = a ? URL.createObjectURL(a.blob) : null;
  const running = ['transcribing', 'summarizing'].includes(m.status) || queue.includes(m.id);
  view.innerHTML = `
    <div class="row"><a href="#/">← 목록</a></div>
    <div data-mid="${m.id}">
      <h2 style="margin:8px 0 2px" id="title">${esc(m.title)}</h2>
      <div class="meta">${fmtDate(m.date)}${m.durationSec ? ` · ${fmtTime(m.durationSec)}` : ''}${m.minutes?.attendees?.length ? ` · 참석: ${esc(m.minutes.attendees.join(', '))}` : ''}</div>
      <div class="stat">${badge(m)}${prog(m)}</div>
      <div class="chips">${(m.tags || []).map((t) => `<a class="chip" href="#/topic/${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}</div>
    </div>
    <div class="player">${audioUrl ? `<audio id="audio" controls preload="metadata" src="${audioUrl}"></audio>` : m.drive?.audioId ? `<button id="fetchAudio">☁️ Drive에서 오디오 불러오기</button>` : '<div class="meta">이 기기에 오디오 없음</div>'}</div>
    <div class="row">
      ${running ? '<button id="stop">⏹ 중지</button>' : `<button class="pri" id="run">${m.segments?.length ? (m.minutes ? '🔁 회의록 다시 생성' : '📝 회의록 생성') : '▶ 전사 + 회의록 생성'}</button>`}
      ${!running && m.segments?.length && audioUrl ? '<button id="retx">🎙️ 다시 전사</button>' : ''}
      <button id="edit">✏️ 편집</button>
      <button id="share">📤 공유</button>
      <button id="export">⬇️ .md</button>
      <button class="danger" id="del">🗑 삭제</button>
    </div>
    <div id="editor"></div>
    <div class="tabs"><button data-t="minutes" class="${tab === 'minutes' ? 'on' : ''}">회의록</button><button data-t="transcript" class="${tab === 'transcript' ? 'on' : ''}">전사본${m.segments?.length ? ` (${m.segments.length})` : ''}</button></div>
    <div id="tabbody"></div>`;

  const body = $('#tabbody');
  if (tab === 'minutes') body.innerHTML = m.minutes ? minutesHtml(m, terms) : `<div class="empty">${m.segments?.length ? '전사가 끝났습니다. 회의록 생성을 눌러 주세요.' : '아직 처리되지 않았습니다.'}</div>`;
  else {
    const speakers = [...new Set((m.segments || []).map((s) => s.speaker).filter((s) => s != null))];
    body.innerHTML = `${speakers.length ? `<div class="row" style="margin-bottom:6px"><button id="spk">👥 화자 이름 지정</button><span class="help">화자 구분은 xAI 음성인식 사용 시 제공</span></div>` : ''}
      <div class="row"><button id="copyTx">📋 전사본 복사</button></div>
      ${(m.segments || []).map((s, i) => `<div class="seg" data-i="${i}" data-st="${s.start}"><span class="t">${fmtTime(s.start)}</span><span>${s.speaker != null ? `<span class="s">${esc(speakerName(m, s.speaker))}:</span> ` : ''}${terms.length ? highlight(s.text, terms) : esc(s.text)}</span></div>`).join('') || '<div class="empty">전사본 없음</div>'}`;
    $$('.seg', body).forEach((el) => el.addEventListener('click', () => { const au = $('#audio'); if (au) { au.currentTime = +el.dataset.st; au.play(); } }));
    $('#spk')?.addEventListener('click', () => editSpeakers(m, speakers));
    $('#copyTx')?.addEventListener('click', () => navigator.clipboard.writeText(transcriptText(m)).then(() => toast('복사됨')));
    if (terms.length) setTimeout(() => body.querySelector('mark')?.scrollIntoView({ block: 'center' }), 50);
    const au = $('#audio');
    if (au) au.addEventListener('timeupdate', () => {
      const t = au.currentTime;
      let cur = null;
      for (const el of $$('.seg', body)) { if (+el.dataset.st <= t) cur = el; else break; }
      $$('.seg.cur', body).forEach((e) => e !== cur && e.classList.remove('cur'));
      if (cur && !cur.classList.contains('cur')) cur.classList.add('cur');
    });
  }
  $$('.minutes [data-seek]', body).forEach((el) => el.addEventListener('click', () => { const au = $('#audio'); if (au) { au.currentTime = +el.dataset.seek; au.play(); } }));
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => { const np = qparams(); np.set('tab', b.dataset.t); history.replaceState(null, '', `#/m/${id}?${np}`); renderDetail(id); }));
  $('#run')?.addEventListener('click', () => { if (m.segments?.length) { m.status = 'transcribed'; } enqueue(m.id); toast('처리 시작'); setTimeout(() => renderDetail(id), 300); });
  $('#retx')?.addEventListener('click', async () => { if (!confirm('현재 설정의 음성인식으로 다시 전사할까요? (기존 전사본/회의록 대체)')) return; m.needsTranscribe = true; m.status = 'imported'; await saveMeeting(m); enqueue(m.id); renderDetail(id); });
  $('#stop')?.addEventListener('click', () => { const qi = queue.indexOf(m.id); if (qi >= 0) queue.splice(qi, 1); abortCtl?.abort(); toast('중지 요청'); });
  $('#fetchAudio')?.addEventListener('click', async (e) => { e.target.disabled = true; e.target.textContent = '불러오는 중…'; try { if (!drive.hasToken()) await drive.connect(settings.driveClientId); await fetchAudioFromDrive(m); renderDetail(id); } catch (err) { toast(err.message, 5000); e.target.disabled = false; } });
  $('#export').addEventListener('click', () => download(`${safeName(m.title)}.md`, exportMarkdown(m)));
  $('#share').addEventListener('click', async () => {
    const md = exportMarkdown(m, { withTranscript: false });
    try {
      const file = new File([md], `${safeName(m.title)}.md`, { type: 'text/markdown' });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: m.title, files: [file], text: md.slice(0, 2000) });
      else if (navigator.share) await navigator.share({ title: m.title, text: md });
      else { await navigator.clipboard.writeText(md); toast('회의록을 클립보드에 복사했습니다'); }
    } catch (e) { if (e.name !== 'AbortError') { await navigator.clipboard.writeText(md).catch(() => {}); toast('클립보드에 복사했습니다'); } }
  });
  $('#del').addEventListener('click', async () => {
    if (!confirm(`"${m.title}" 회의를 삭제할까요?\n(이 기기와 동기화된 모든 기기에서 사라집니다. Drive의 오디오는 휴지통으로 이동)`)) return;
    m.deleted = true; m.segments = []; m.minutes = null; m.minutesMd = ''; m.chunkResults = null;
    await db.del('audio', m.id); m.audioLocal = false;
    if (m.drive?.audioId && drive.hasToken()) { try { await drive.trash(m.drive.audioId); m.drive.audioId = null; } catch {} }
    await saveMeeting(m); await reload(); scheduleSync(); location.hash = '#/';
  });
  $('#edit').addEventListener('click', () => {
    const ed = $('#editor');
    if (ed.innerHTML) { ed.innerHTML = ''; return; }
    const local = m.date ? new Date(new Date(m.date).getTime() + 9 * 3600e3).toISOString().slice(0, 16) : '';
    ed.innerHTML = `<div class="card" data-editing>
      <label>제목</label><input id="eTitle" type="text" value="${esc(m.title)}">
      <label>일시 (KST)</label><input id="eDate" type="datetime-local" value="${local}">
      <label>태그 (쉼표로 구분)</label><input id="eTags" type="text" value="${esc((m.tags || []).join(', '))}">
      <label>메모 (회의록 생성 시 참고: 참석자, 배경 등)</label><textarea id="eNotes">${esc(m.notes || '')}</textarea>
      <div class="row" style="margin-top:10px"><button class="pri" id="eSave">저장</button><button id="eCancel">취소</button></div></div>`;
    $('#eCancel').onclick = () => (ed.innerHTML = '');
    $('#eSave').onclick = async () => {
      const t = $('#eTitle').value.trim(), tags = $('#eTags').value.split(',').map((x) => x.trim().replace(/^#/, '')).filter(Boolean);
      if (t !== m.title) { m.title = t || m.title; m.titleEdited = true; }
      if (JSON.stringify(tags) !== JSON.stringify(m.tags || [])) { m.tags = [...new Set(tags)]; m.tagsEdited = true; }
      if ($('#eDate').value) m.date = new Date($('#eDate').value + ':00+09:00').toISOString();
      m.notes = $('#eNotes').value.trim();
      if (m.minutes) m.minutesMd = minutesToMarkdown(m);
      await saveMeeting(m); scheduleSync(); toast('저장됨'); renderDetail(id);
    };
  });
}

function minutesHtml(m, terms) {
  const mm = m.minutes;
  const H = (s) => (terms.length ? highlight(s, terms) : esc(s));
  const seekOf = (tr) => { const x = String(tr || '').match(/(\d+):(\d{2})(?::(\d{2}))?/); if (!x) return null; return x[3] ? +x[1] * 3600 + +x[2] * 60 + +x[3] : +x[1] * 60 + +x[2]; };
  const ai = (a) => `<li>☐ <b>${H(a.owner || '미정')}</b> — ${H(a.task)}${a.due ? ` <span class="badge">${H(a.due)}</span>` : ''}</li>`;
  return `<div class="minutes">
    <h2>전체 요약</h2><p>${H(mm.overall_summary)}</p>
    ${mm.topics?.length ? `<h2>주제별 논의 (${mm.topics.length})</h2>` : ''}
    ${(mm.topics || []).map((t, i) => { const sk = seekOf(t.time_range); return `<div class="topic">
      <h3>${i + 1}. ${H(t.title)} ${t.tag ? `<a class="chip" href="#/topic/${encodeURIComponent(t.tag)}">#${esc(t.tag)}</a>` : ''} ${t.time_range ? `<span class="meta" ${sk != null ? `data-seek="${sk}" style="cursor:pointer;color:var(--pri)"` : ''}>⏱ ${esc(t.time_range)}</span>` : ''}</h3>
      <p>${H(t.summary)}</p>
      ${t.key_points?.length ? `<h4>주요 내용</h4><ul>${t.key_points.map((p) => `<li>${H(p)}</li>`).join('')}</ul>` : ''}
      ${t.decisions?.length ? `<h4>결정사항</h4><ul>${t.decisions.map((p) => `<li>✅ ${H(p)}</li>`).join('')}</ul>` : ''}
      ${t.action_items?.length ? `<h4>할 일</h4><ul>${t.action_items.map(ai).join('')}</ul>` : ''}
    </div>`; }).join('')}
    ${mm.action_items?.length ? `<h2>전체 할 일</h2><ul>${mm.action_items.map(ai).join('')}</ul>` : ''}
    ${mm.open_issues?.length ? `<h2>미해결 사항</h2><ul>${mm.open_issues.map((p) => `<li>${H(p)}</li>`).join('')}</ul>` : ''}
    <p class="help">작성: ${esc(m.transcribedWith || '')} → ${esc(m.summarizedWith || '')}</p>
  </div>`;
}

async function editSpeakers(m, speakers) {
  for (const s of speakers) {
    const n = prompt(`${speakerName(m, s)}의 이름 (비우면 유지)`, m.speakers?.[s] || '');
    if (n === null) break;
    if (n.trim()) m.speakers = { ...(m.speakers || {}), [s]: n.trim() };
  }
  await saveMeeting(m); scheduleSync();
  if (m.minutes && confirm('화자 이름을 반영해 회의록을 다시 생성할까요?')) { m.status = 'transcribed'; enqueue(m.id); }
  renderDetail(m.id);
}

// ---------------- 화면: 주제 ----------------
async function renderTopics() {
  const tags = tagCounts(visible());
  const topics = new Map((await db.all('topics')).map((t) => [t.tag, t]));
  view.innerHTML = `<h2>주제별 보기</h2><p class="help">회의록의 주제 태그로 여러 회의를 묶어 봅니다. 주제를 누르면 회의 간 종합 요약을 만들 수 있습니다.</p>
    ${tags.length ? tags.map(([t, n]) => {
      const last = visible().filter((m) => (m.tags || []).includes(t)).map((m) => m.date).sort().pop();
      return `<a class="card mcard" href="#/topic/${encodeURIComponent(t)}"><div class="row"><b class="grow">#${esc(t)}</b><span class="badge">${n}회</span></div><div class="meta">최근 ${fmtDate(last)}${topics.get(t) ? ' · 종합 요약 있음' : ''}</div></a>`;
    }).join('') : '<div class="empty">아직 주제가 없습니다. 회의록이 생성되면 자동으로 태그가 붙습니다.</div>'}`;
}
async function renderTopic(tag) {
  const list = visible().filter((m) => (m.tags || []).includes(tag) || (m.minutes?.topics || []).some((t) => t.tag === tag)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const saved = await db.get('topics', tag);
  const stale = saved && list.some((m) => !saved.meetingIds?.includes(m.id));
  view.innerHTML = `<div class="row"><a href="#/topics">← 주제</a></div>
    <h2>#${esc(tag)} <span class="badge">${list.length}회</span></h2>
    <div class="card minutes"><div class="row"><b class="grow">회의 간 종합 요약</b><button class="pri" id="roll">${saved ? '🔁 다시 생성' : '✨ 종합 요약 생성'}</button></div>
      ${saved ? `<div class="meta">${new Date(saved.updatedAt).toLocaleString('ko-KR')} 생성 · 회의 ${saved.meetingIds?.length || 0}개 기준${stale ? ' · <b style="color:var(--warn)">새 회의가 추가됨</b>' : ''}</div>${mdToHtml(saved.summaryMd)}` : '<p class="help">이 주제가 다뤄진 모든 회의의 결정사항·할 일·경과를 한 번에 정리합니다.</p>'}
      ${saved ? '<button id="rollMd">⬇️ .md 저장</button>' : ''}
    </div>
    ${list.map((m) => {
      const rel = (m.minutes?.topics || []).filter((t) => t.tag === tag);
      return `<a class="card mcard" href="#/m/${m.id}"><b>${esc(m.title)}</b><div class="meta">${fmtDate(m.date)}</div>${rel.map((t) => `<div class="snip"><b>${esc(t.title)}</b> — ${esc(t.summary)}</div>`).join('') || `<div class="snip">${esc((m.minutes?.overall_summary || '').slice(0, 160))}</div>`}</a>`;
    }).join('')}`;
  $('#roll').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = '⏳ 생성 중…';
    try {
      const md = await generateTopicRollup(llmConfig(settings, keys), tag, list.filter((m) => m.minutes));
      await db.put('topics', { tag, summaryMd: md, meetingIds: list.map((m) => m.id), updatedAt: Date.now() });
      scheduleSync(); renderTopic(tag);
    } catch (err) { toast(err.message, 5000); e.target.disabled = false; e.target.textContent = '다시 시도'; }
  });
  $('#rollMd')?.addEventListener('click', () => download(`주제_${safeName(tag)}.md`, `# 주제: ${tag}\n\n${saved.summaryMd}`));
}

// ---------------- 화면: 설정 ----------------
async function renderSettings() {
  settings = await loadSettings(); keys = await loadKeys();
  const s = settings;
  const sP = STT_PROVIDERS[s.sttProvider], lP = LLM_PROVIDERS[s.llmProvider];
  const so = s.stt[s.sttProvider] || {}, lo = s.llm[s.llmProvider] || {};
  const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
  const lastSync = await kvGet('lastSync');
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  view.innerHTML = `<h2>설정</h2>
  <fieldset><legend>빠른 설정</legend>
    ${Object.entries(PRESETS).map(([k, p]) => `<button data-preset="${k}" style="margin:4px 4px 0 0">${esc(p.label)}</button>`).join('')}
    <p class="help">무료 조합: Groq 하루 8시간 무료 전사 + Gemini 무료 요약. Grok 조합: 화자 구분 지원, 1시간 회의 약 $0.13(전사 $0.10 + 요약 약 $0.03).</p>
  </fieldset>
  <fieldset><legend>API 키 (이 기기에만 암호화 저장)</legend>
    <label>Groq API 키 — <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a> (무료)</label><input type="password" id="k_groq" value="${esc(keys.groq || '')}" autocomplete="off" placeholder="gsk_...">
    <label>xAI API 키 — <a href="https://console.x.ai" target="_blank" rel="noopener">console.x.ai</a> (Grok, 유료)</label><input type="password" id="k_xai" value="${esc(keys.xai || '')}" autocomplete="off" placeholder="xai-...">
    <label>Gemini API 키 — <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> (무료 티어)</label><input type="password" id="k_gemini" value="${esc(keys.gemini || '')}" autocomplete="off" placeholder="AIza...">
    <details><summary>직접 입력(OpenAI 호환) 키</summary>
      <label>음성인식용 키</label><input type="password" id="k_custom_stt" value="${esc(keys.custom_stt || '')}" autocomplete="off">
      <label>요약용 키</label><input type="password" id="k_custom_llm" value="${esc(keys.custom_llm || '')}" autocomplete="off">
    </details>
    <div class="row" style="margin-top:8px"><button id="testKeys">🔑 키 확인</button><span id="testOut" class="help"></span></div>
  </fieldset>
  <fieldset><legend>음성 인식 (전사)</legend>
    <label>프로바이더</label><select id="sttProvider">${opt(STT_PROVIDERS, s.sttProvider)}</select>
    <label>모델</label><input type="text" id="sttModel" value="${esc(so.model || sP.model)}">
    <label>청크 길이(분, 0=분할 안 함)</label><input type="number" id="sttChunk" min="0" max="180" value="${so.chunkMin ?? sP.chunkMin}">
    <label class="row"><input type="checkbox" id="diarize" ${s.diarize ? 'checked' : ''}> 화자 구분 (xAI만 지원)</label>
    <label>용어 사전 (사람 이름·제품명 등, 쉼표 구분 — 인식 정확도 향상)</label><textarea id="keyterms" placeholder="예: 플라우드, 홍길동, OKR, 베타 출시">${esc(s.keyterms)}</textarea>
    <label>언어 코드</label><input type="text" id="language" value="${esc(s.language)}">
    <details><summary>고급: Base URL</summary><input type="url" id="sttBase" value="${esc(so.baseUrl || sP.baseUrl)}"></details>
  </fieldset>
  <fieldset><legend>회의록 요약 (LLM)</legend>
    <label>프로바이더</label><select id="llmProvider">${opt(LLM_PROVIDERS, s.llmProvider)}</select>
    <label>모델</label><input type="text" id="llmModel" value="${esc(lo.model || lP.model)}">
    <p class="help">xAI 예: grok-4.3(저렴), grok-4.7(최고 성능) · Gemini 예: gemini-3.8-flash, gemini-3.5-flash-lite · Groq 예: openai/gpt-oss-120b</p>
    <label>한 번에 보낼 최대 글자 수 (넘으면 나눠 요약 후 통합)</label><input type="number" id="llmMax" value="${lo.maxInputChars || lP.maxInputChars}">
    <details><summary>고급: Base URL</summary><input type="url" id="llmBase" value="${esc(lo.baseUrl || lP.baseUrl)}"></details>
  </fieldset>
  <fieldset><legend>처리</legend>
    <label class="row"><input type="checkbox" id="autoProcess" ${s.autoProcess ? 'checked' : ''}> 가져오면 자동으로 전사·회의록 생성</label>
  </fieldset>
  <fieldset><legend>PC·휴대폰 동기화 (Google Drive)</legend>
    <p class="help">녹음·전사본·회의록을 <b>내 Google Drive의 "Plaud 회의록" 폴더</b>에 저장해 PC와 휴대폰이 같은 보관함을 씁니다. 이 앱이 만든 파일만 접근합니다(drive.file 권한).</p>
    <label>Google OAuth 클라이언트 ID (README의 5분 설정 참고)</label><input type="text" id="driveClientId" value="${esc(s.driveClientId)}" placeholder="1234-abc.apps.googleusercontent.com">
    <div class="row" style="margin-top:8px">${drive.hasToken() ? '<button id="syncNowBtn" class="pri">⟳ 지금 동기화</button><button id="disc">연결 해제</button>' : '<button id="conn" class="pri">Google Drive 연결</button>'}</div>
    <p class="help">마지막 동기화: ${lastSync ? new Date(lastSync).toLocaleString('ko-KR') : '없음'}</p>
    <label class="row"><input type="checkbox" id="autoSync" ${s.autoSync ? 'checked' : ''}> 변경 시 자동 동기화 (연결된 동안)</label>
    <label class="row"><input type="checkbox" id="evict" ${s.evictAudioAfterUpload ? 'checked' : ''}> Drive 업로드 후 이 기기에서 오디오 삭제(용량 절약, 필요 시 다시 불러옴)</label>
    <label class="row"><input type="checkbox" id="syncKeys" ${s.syncKeys ? 'checked' : ''}> 설정 저장 시 API 키도 포함 (내 Drive에 평문 저장됨)</label>
    <div class="row"><button id="saveCfg">설정을 Drive에 저장</button><button id="loadCfg">Drive에서 설정 불러오기</button></div>
  </fieldset>
  <fieldset><legend>백업 / 저장공간</legend>
    <div class="row"><button id="backup">⬇️ 전체 백업(JSON, 오디오 제외)</button><label class="btn">⬆️ 백업 복원<input type="file" id="restore" accept=".json" hidden></label></div>
    <p class="help">${est ? `브라우저 저장공간 사용: ${(est.usage / 1048576).toFixed(0)}MB / 가능 ${(est.quota / 1073741824).toFixed(1)}GB` : ''}</p>
  </fieldset>
  <div class="row" style="position:sticky;bottom:70px"><button class="pri" id="save" style="flex:1">💾 저장</button></div>
  <p class="help">Plaud 회의록 v1 · 오픈소스 · 서버 없음: 모든 처리는 이 브라우저에서 각 AI 서비스로 직접 요청합니다.</p>`;

  const collect = async () => {
    const ns = { ...settings, stt: { ...settings.stt }, llm: { ...settings.llm } };
    ns.sttProvider = $('#sttProvider').value; ns.llmProvider = $('#llmProvider').value;
    // 현재 화면에 표시된 프로바이더의 세부값 저장 (프로바이더 변경 직후엔 기본값 사용)
    if (ns.sttProvider === settings.sttProvider) ns.stt[ns.sttProvider] = { model: $('#sttModel').value.trim(), chunkMin: Number($('#sttChunk').value), baseUrl: $('#sttBase').value.trim() };
    if (ns.llmProvider === settings.llmProvider) ns.llm[ns.llmProvider] = { model: $('#llmModel').value.trim(), maxInputChars: Number($('#llmMax').value) || undefined, baseUrl: $('#llmBase').value.trim() };
    Object.assign(ns, { diarize: $('#diarize').checked, keyterms: $('#keyterms').value, language: $('#language').value.trim() || 'ko', autoProcess: $('#autoProcess').checked, driveClientId: $('#driveClientId').value.trim(), autoSync: $('#autoSync').checked, evictAudioAfterUpload: $('#evict').checked, syncKeys: $('#syncKeys').checked });
    const nk = {};
    for (const k of ['groq', 'xai', 'gemini', 'custom_stt', 'custom_llm']) { const v = $(`#k_${k}`).value.trim(); if (v) nk[k] = v; }
    await saveSettings(ns); await saveKeys(nk);
    settings = ns; keys = nk;
  };
  $('#save').onclick = async () => { await collect(); toast('저장되었습니다'); renderSettings(); };
  $('#sttProvider').onchange = $('#llmProvider').onchange = async () => { await collect(); renderSettings(); };
  $$('[data-preset]').forEach((b) => (b.onclick = async () => { await collect(); const p = PRESETS[b.dataset.preset]; settings.sttProvider = p.sttProvider; settings.llmProvider = p.llmProvider; await saveSettings(settings); toast(`적용: ${p.label}`); renderSettings(); }));
  $('#testKeys').onclick = async () => {
    await collect();
    const out = $('#testOut'); out.textContent = '확인 중…';
    const check = async (label, base, key) => {
      if (!key) return `${label}: 키 없음`;
      try { const r = await fetch(`${base.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` } }); return `${label}: ${r.ok ? '✅' : `❌ ${r.status}`}`; } catch (e) { return `${label}: ❌ ${e.message}`; }
    };
    const st = sttConfig(settings, keys), lc = llmConfig(settings, keys);
    out.textContent = (await Promise.all([check(`음성인식(${st.provider})`, st.baseUrl, st.apiKey), check(`요약(${lc.provider})`, lc.baseUrl, lc.apiKey)])).join(' · ');
  };
  $('#conn')?.addEventListener('click', async () => { await collect(); try { await drive.connect(settings.driveClientId, { prompt: 'consent' }); $('#syncBtn').hidden = false; toast('Google Drive 연결됨'); await runSync(true); renderSettings(); } catch (e) { toast(e.message, 5000); } });
  $('#disc')?.addEventListener('click', () => { drive.disconnect(); $('#syncBtn').hidden = true; renderSettings(); });
  $('#syncNowBtn')?.addEventListener('click', async () => { await collect(); await runSync(true); renderSettings(); });
  $('#saveCfg').onclick = async () => { await collect(); try { if (!drive.hasToken()) await drive.connect(settings.driveClientId); await saveSettingsToDrive(settings, keys); toast('Drive에 설정 저장됨'); } catch (e) { toast(e.message, 5000); } };
  $('#loadCfg').onclick = async () => {
    await collect();
    try {
      if (!drive.hasToken()) await drive.connect(settings.driveClientId);
      const r = await loadSettingsFromDrive();
      await saveSettings({ ...r.settings, driveClientId: settings.driveClientId });
      if (r.keys) await saveKeys({ ...keys, ...r.keys });
      toast('Drive의 설정을 불러왔습니다'); renderSettings();
    } catch (e) { toast(e.message, 5000); }
  };
  $('#backup').onclick = async () => {
    const all = (await db.all('meetings')).filter((m) => !m.deleted);
    download(`plaud-minutes-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 1, meetings: all.map(({ audioLocal, ...m }) => m), topics: await db.all('topics') }), 'application/json');
  };
  $('#restore').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      let n = 0;
      for (const m of j.meetings || []) { const cur = await db.get('meetings', m.id); if (!cur || (m.updatedAt || 0) > (cur.updatedAt || 0)) { await db.put('meetings', { ...m, audioLocal: cur?.audioLocal || false }); n++; } }
      for (const t of j.topics || []) await db.put('topics', t);
      await reload(); toast(`${n}개 회의 복원`);
    } catch (err) { toast(`복원 실패: ${err.message}`); }
  };
}

// ---------------- 라우터 ----------------
function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  const path = h.split('?')[0];
  const tab = path.startsWith('/topic') ? 'topics' : path.startsWith('/import') ? 'import' : path.startsWith('/settings') ? 'settings' : 'list';
  $$('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  let m;
  if ((m = path.match(/^\/m\/(.+)$/))) return renderDetail(decodeURIComponent(m[1]));
  if ((m = path.match(/^\/topic\/(.+)$/))) return renderTopic(decodeURIComponent(m[1]));
  if (path === '/topics') return renderTopics();
  if (path === '/import') return renderImport();
  if (path === '/settings') return renderSettings();
  return renderList();
}

async function init() {
  settings = await loadSettings(); keys = await loadKeys();
  await reload();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  navigator.storage?.persist?.().catch(() => {});
  // PC 크롬 설치 앱: 파일 열기 핸들러
  if ('launchQueue' in window) launchQueue.setConsumer(async (p) => { for (const h of p.files || []) await importFile(await h.getFile()); route(); });
  await drainInbox();
  if (drive.restoreToken()) { $('#syncBtn').hidden = false; autoSync(); }
  else if (settings.driveClientId) { $('#syncBtn').hidden = false; setSync('☁️ 탭하여 동기화'); }
  $('#syncBtn').onclick = () => runSync(true);
  $('#syncStatus').onclick = () => runSync(true);
  window.addEventListener('hashchange', route);
  // 이전에 중단된 작업 재개 (API 키가 있을 때만)
  const ready = sttConfig(settings, keys).apiKey && llmConfig(settings, keys).apiKey;
  for (const m of ready ? meetings : []) {
    if (['transcribing', 'summarizing'].includes(m.status) && settings.autoProcess) enqueue(m.id);
    else if (m.status === 'imported' && settings.autoProcess && m.audioLocal) enqueue(m.id);
    else if (m.status === 'paused' && m.resumeAt) setTimeout(() => enqueue(m.id), Math.max(3000, m.resumeAt - Date.now()));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) drainInbox().then((n) => n && route()); });
  route();
}
init();
window.__pm = { importFile, meetings: () => meetings, db, enqueue };
