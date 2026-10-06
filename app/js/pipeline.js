// 처리 파이프라인: 분할 → 전사(청크별, 재개 가능) → 회의록 생성
import { prepareAudio, materializeChunk } from './audio.js';
import { transcribeChunk, offsetSegments } from './stt.js';
import { generateMinutes } from './llm.js';
import { minutesToMarkdown } from './minutes.js';
import { RateLimitError } from './net.js';

/**
 * store: { getAudio(id) -> Blob, save(meeting), existingTags() -> string[] }
 * cfg: { stt: sttConfig, llm: llmConfig }
 * emit(meeting): 진행 상황 UI 갱신
 */
export async function processMeeting(meeting, store, cfg, emit = () => {}, { signal } = {}) {
  const set = async (patch) => { Object.assign(meeting, patch); await store.save(meeting); emit(meeting); };
  try {
    if (!meeting.segments?.length || meeting.status === 'transcribing' || meeting.status === 'imported' || meeting.needsTranscribe) {
      await transcribe(meeting, store, cfg.stt, set, signal);
    }
    await set({ status: 'summarizing', progress: 0, step: '회의록 작성 중', error: '' });
    const minutes = await generateMinutes(cfg.llm, meeting, await store.existingTags(), {
      signal, onStep: (s) => set({ step: s }), onWait: (w, why) => set({ step: `${why}: ${Math.ceil(w)}초 대기` }),
    });
    const patch = { minutes, status: 'done', step: '', progress: 1, error: '', summarizedWith: `${cfg.llm.provider}/${cfg.llm.model}` };
    if (!meeting.titleEdited && minutes.title) patch.title = minutes.title;
    if (!meeting.tagsEdited) patch.tags = minutes.tags;
    Object.assign(meeting, patch);
    meeting.minutesMd = minutesToMarkdown(meeting);
    await set({});
    return meeting;
  } catch (e) {
    if (e.name === 'AbortError') { await set({ status: meeting.segments?.length ? 'transcribed' : 'imported', step: '중지됨' }); return meeting; }
    const paused = e instanceof RateLimitError;
    await set({ status: paused ? 'paused' : 'error', error: e.message, step: '', resumeAt: paused ? Date.now() + e.waitSec * 1000 : null });
    throw e;
  }
}

async function transcribe(meeting, store, stt, set, signal) {
  const blob = await store.getAudio(meeting.id);
  if (!blob) throw new Error('이 기기에 오디오가 없습니다. Drive에서 오디오를 먼저 불러오세요.');
  await set({ status: 'transcribing', step: '오디오 분석 중', progress: 0, error: '' });
  const prep = await prepareAudio(blob, meeting.fileName, meeting.mime, stt.limits, (p) => set({ progress: p * 0.05 }));
  // 이전 진행분 재사용 (같은 프로바이더/분할 계획일 때만)
  const planKey = `${stt.provider}|${stt.limits.maxBytes}|${stt.limits.maxSec}|${prep.chunks.length}`;
  let done = meeting.chunkPlanKey === planKey && Array.isArray(meeting.chunkResults) ? meeting.chunkResults : [];
  if (meeting.needsTranscribe) done = [];
  await set({ durationSec: prep.duration || meeting.durationSec || 0, chunkPlanKey: planKey, chunkTotal: prep.chunks.length, chunkResults: done, needsTranscribe: false });
  for (let i = 0; i < prep.chunks.length; i++) {
    if (done[i]) continue;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const c = prep.chunks[i];
    await set({ step: `음성 인식 ${i + 1}/${prep.chunks.length}`, progress: 0.05 + 0.95 * (i / prep.chunks.length) });
    const { blob: part, filename } = await materializeChunk(blob, prep, c, meeting.fileName);
    const prev = i > 0 && done[i - 1] ? done[i - 1].map((s) => s.text).join(' ') : '';
    const r = await transcribeChunk({ ...stt, prevText: prev }, part, filename, {
      signal, onWait: (w, why) => set({ step: `${why}: ${Math.ceil(w)}초 대기 (청크 ${i + 1})` }),
    });
    done[i] = offsetSegments(r.segments, c.start);
    if (!prep.duration && r.duration) meeting.durationSec = r.duration;
    await set({ chunkResults: done });
  }
  const segments = done.flat();
  await set({ segments, status: 'transcribed', progress: 1, step: '', transcribedWith: `${stt.provider}/${stt.model}`, chunkResults: null });
}
