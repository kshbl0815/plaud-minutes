// 음성 인식(STT) 프로바이더
import { fetchRetry } from './net.js';

export const STT_PROVIDERS = {
  groq: {
    label: 'Groq Whisper (무료 티어)',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3',
    maxBytes: 24 * 1024 * 1024, // 무료 티어 25MB
    chunkMin: 10,
    kind: 'openai',
  },
  xai: {
    label: 'xAI Grok Speech-to-Text (화자 구분, 유료 $0.10/시간)',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-voice-transcribe-2.0',
    maxBytes: 480 * 1024 * 1024, // 500MB
    chunkMin: 0,
    kind: 'xai',
  },
  custom: {
    label: 'OpenAI 호환 (직접 입력: OpenAI, 자체 Whisper 서버 등)',
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    maxBytes: 24 * 1024 * 1024,
    chunkMin: 10,
    kind: 'openai',
  },
};

// Whisper가 무음/잡음 구간에서 자주 만들어내는 한국어 환각 문구
const HALLUCINATIONS = [
  /시청해\s*주셔서\s*감사합니다/, /구독과\s*좋아요/, /좋아요와\s*구독/, /구독\s*부탁/, /MBC\s*뉴스/, /KBS\s*뉴스/, /SBS\s*뉴스/,
  /자막\s*(제작|제공|by)/i, /다음\s*영상에서\s*만나요/, /끝까지\s*시청/, /한글자막/, /Thank you for watching/i,
];
const SOFT_HALLUCINATIONS = [/^\s*(감사합니다|고맙습니다|네)[.!\s]*$/];

export function isHallucination(seg) {
  const t = (seg.text || '').trim();
  if (!t) return true;
  if (seg.no_speech_prob != null && seg.avg_logprob != null && seg.no_speech_prob > 0.6 && seg.avg_logprob < -1) return true;
  if (t.length <= 30 && HALLUCINATIONS.some((r) => r.test(t))) return true;
  if (SOFT_HALLUCINATIONS.some((r) => r.test(t)) && ((seg.no_speech_prob ?? 0) > 0.3 || (seg.avg_logprob ?? 0) < -0.8)) return true;
  if (seg.compression_ratio != null && seg.compression_ratio > 2.8) return true;
  return false;
}

/** 같은 문장이 연속 반복되는 환각(루프) 제거 */
export function dedupeRepeats(segs, maxRepeat = 2) {
  const out = [];
  let run = 0;
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.text.trim() === s.text.trim()) { run++; if (run >= maxRepeat) continue; } else run = 0;
    out.push(s);
  }
  return out;
}

export function cleanSegments(segs) {
  return dedupeRepeats(segs.filter((s) => !isHallucination(s)).map((s) => ({ ...s, text: s.text.trim() })));
}

/** xAI 단어 단위 결과 → 문장/화자 단위 세그먼트 */
export function wordsToSegments(words, { maxGap = 1.2, maxLen = 25 } = {}) {
  const segs = [];
  let cur = null;
  for (const w of words || []) {
    const text = (w.text ?? w.word ?? '').trim();
    if (!text) continue;
    const brk = !cur || (w.speaker != null && w.speaker !== cur.speaker) || w.start - cur.end > maxGap || w.end - cur.start > maxLen || /[.?!。]$/.test(cur.text) && w.end - cur.start > 6;
    if (brk) { if (cur) segs.push(cur); cur = { start: w.start, end: w.end, text, speaker: w.speaker }; }
    else { cur.text += ' ' + text; cur.end = w.end; }
  }
  if (cur) segs.push(cur);
  return segs;
}

export function buildPrompt(keyterms, prevText) {
  // Whisper prompt: 맞춤법/고유명사 힌트 + 직전 청크 마지막 문장 (최대 ~200자)
  const terms = (keyterms || []).slice(0, 30).join(', ');
  let p = '다음은 한국어 회의 녹음입니다.';
  if (terms) p += ` 주요 용어: ${terms}.`;
  if (prevText) p += ' ' + prevText.slice(-150);
  return p.slice(0, 400);
}

/**
 * 청크 하나 전사. 반환: { segments:[{start,end,text,speaker?}], text, duration }
 * 세그먼트 시간은 청크 시작 기준(0부터) → 호출측에서 offset 더함
 */
export async function transcribeChunk({ provider, apiKey, baseUrl, model, language = 'ko', keyterms = [], prevText = '', diarize = true }, blob, filename, hooks = {}) {
  const P = STT_PROVIDERS[provider];
  if (!P) throw new Error(`알 수 없는 STT 프로바이더: ${provider}`);
  if (!apiKey) throw new Error(`${P.label} API 키가 설정되지 않았습니다 (설정 화면에서 입력)`);
  const base = (baseUrl || P.baseUrl).replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${apiKey}` };

  if (P.kind === 'xai') {
    const make = () => {
      const fd = new FormData();
      fd.append('model', model || P.model);
      if (language) fd.append('language', language);
      fd.append('diarize', diarize ? 'true' : 'false');
      fd.append('filler_words', 'false');
      for (const k of keyterms.slice(0, 100)) fd.append('keyterm', k.slice(0, 50));
      fd.append('file', blob, filename); // file은 마지막 필드여야 함
      return { method: 'POST', headers, body: fd, signal: hooks.signal };
    };
    const res = await fetchRetry(`${base}/stt`, make, hooks);
    const j = await res.json();
    let segments = wordsToSegments(j.words || []);
    if (!segments.length && j.text) segments = [{ start: 0, end: j.duration || 0, text: j.text }];
    return { segments: cleanSegments(segments), text: j.text || '', duration: j.duration };
  }

  const make = () => {
    const fd = new FormData();
    fd.append('model', model || P.model);
    if (language) fd.append('language', language);
    fd.append('response_format', 'verbose_json');
    fd.append('temperature', '0');
    fd.append('timestamp_granularities[]', 'segment');
    fd.append('prompt', buildPrompt(keyterms, prevText));
    fd.append('file', blob, filename);
    return { method: 'POST', headers, body: fd, signal: hooks.signal };
  };
  const res = await fetchRetry(`${base}/audio/transcriptions`, make, hooks);
  const j = await res.json();
  let segments = (j.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text, no_speech_prob: s.no_speech_prob, avg_logprob: s.avg_logprob, compression_ratio: s.compression_ratio }));
  if (!segments.length && j.text) segments = [{ start: 0, end: j.duration || 0, text: j.text }];
  segments = cleanSegments(segments).map(({ start, end, text }) => ({ start, end, text }));
  return { segments, text: segments.map((s) => s.text).join(' '), duration: j.duration };
}

export function offsetSegments(segs, offset) {
  return segs.map((s) => ({ ...s, start: +(s.start + offset).toFixed(2), end: +(s.end + offset).toFixed(2) }));
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export function speakerName(meeting, spk) {
  if (spk == null) return '';
  return meeting?.speakers?.[spk] || `화자 ${Number(spk) + 1}`;
}

export function transcriptText(meeting, { withTime = true } = {}) {
  return (meeting.segments || []).map((s) => {
    const sp = s.speaker != null ? `${speakerName(meeting, s.speaker)}: ` : '';
    return `${withTime ? `[${fmtTime(s.start)}] ` : ''}${sp}${s.text}`;
  }).join('\n');
}
