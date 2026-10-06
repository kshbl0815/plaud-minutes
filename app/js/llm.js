// 요약 LLM (모두 OpenAI 호환 Chat Completions 엔드포인트 사용)
import { fetchRetry, ApiError } from './net.js';
import { fmtTime, speakerName } from './stt.js';

export const LLM_PROVIDERS = {
  xai: { label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.3', maxInputChars: 300000 },
  gemini: { label: 'Google Gemini (무료 티어)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', maxInputChars: 300000 },
  groq: { label: 'Groq (무료, 긴 회의엔 부적합)', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', maxInputChars: 12000 },
  custom: { label: 'OpenAI 호환 (직접 입력)', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', maxInputChars: 100000 },
};

export function extractJson(text) {
  if (!text) throw new Error('빈 응답');
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('JSON 파싱 실패');
}

export async function chat({ provider, apiKey, baseUrl, model }, messages, { json = false, temperature = 0.2, hooks = {} } = {}) {
  const P = LLM_PROVIDERS[provider];
  if (!P) throw new Error(`알 수 없는 요약 프로바이더: ${provider}`);
  if (!apiKey) throw new Error(`${P.label} API 키가 설정되지 않았습니다 (설정 화면에서 입력)`);
  const url = `${(baseUrl || P.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const body = { model: model || P.model, messages, temperature };
  if (json) body.response_format = { type: 'json_object' };
  const make = (b) => () => ({ method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(b), signal: hooks.signal });
  let res;
  try {
    res = await fetchRetry(url, make(body), hooks);
  } catch (e) {
    // response_format 미지원 모델이면 없이 재시도
    if (json && e instanceof ApiError && e.status === 400 && /response_format|json/i.test(e.body || '')) {
      delete body.response_format;
      res = await fetchRetry(url, make(body), hooks);
    } else throw e;
  }
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content;
  if (content == null) throw new Error('모델 응답이 비어 있습니다');
  return typeof content === 'string' ? content : content.map((c) => c.text || '').join('');
}

// ---------------- 프롬프트 ----------------
const MINUTES_SCHEMA = `{
  "title": "회의 제목 (구체적으로, 30자 이내)",
  "date": "YYYY-MM-DD (대화에서 알 수 없으면 빈 문자열)",
  "attendees": ["대화에서 확인되는 참석자 이름/직함 (추측 금지)"],
  "overall_summary": "회의 전체 요약 3~6문장",
  "topics": [
    {
      "title": "논의 주제명",
      "tag": "주제 태그 (2~10자 명사형, 회의 간 묶기용)",
      "time_range": "MM:SS-MM:SS (전사본 타임스탬프 기준)",
      "summary": "이 주제의 논의 요약 2~5문장",
      "key_points": ["핵심 논의 내용"],
      "decisions": ["결정된 사항 (없으면 빈 배열)"],
      "action_items": [{"owner": "담당자(불명확하면 미정)", "task": "할 일", "due": "기한(언급 없으면 빈 문자열)"}]
    }
  ],
  "action_items": [{"owner": "", "task": "", "due": ""}],
  "open_issues": ["결론 나지 않은 사항/추후 논의 필요"],
  "tags": ["이 회의 전체를 대표하는 주제 태그 1~5개"],
  "keywords": ["검색용 핵심 키워드 5~15개 (고유명사, 제품명, 숫자 포함)"]
}`;

export function minutesSystemPrompt() {
  return `당신은 한국어 회의록 작성 전문가입니다. 음성 인식으로 만든 회의 전사본을 받아 정확하고 실무적인 회의록을 작성합니다.
규칙:
- 반드시 한국어로, 아래 JSON 스키마 그대로만 출력합니다 (마크다운/설명 금지).
- 전사본은 음성 인식 오류가 있을 수 있으니 문맥상 명백한 오인식은 바로잡되, 없는 내용을 지어내지 않습니다.
- 회의를 논의 주제별로 나눠 topics 배열에 시간 순서대로 정리합니다. 잡담/인사는 제외합니다.
- 결정사항과 액션아이템(누가/무엇을/언제)을 빠짐없이 뽑습니다. 액션아이템은 topics 안과 최상위 action_items(전체 모음) 모두에 넣습니다.
- 태그는 회의 간 주제별 묶음에 쓰이므로 짧고 일관된 명사형으로 씁니다. 기존 태그 목록에 같은 의미가 있으면 그 표기를 그대로 재사용합니다.
JSON 스키마:
${MINUTES_SCHEMA}`;
}

export function formatTranscript(meeting, segments = meeting.segments || []) {
  return segments.map((s) => `[${fmtTime(s.start)}]${s.speaker != null ? ` ${speakerName(meeting, s.speaker)}:` : ''} ${s.text}`).join('\n');
}

/** 긴 전사본을 maxChars 이하 파트로 (줄 경계 유지) */
export function splitTranscript(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > maxChars && cur) { parts.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) parts.push(cur);
  return parts;
}

function userMsg(meeting, transcript, existingTags, partInfo) {
  const ctx = [
    `파일명: ${meeting.fileName || ''}`,
    `녹음 일시: ${meeting.date ? new Date(meeting.date).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '알 수 없음'}`,
    meeting.durationSec ? `길이: ${fmtTime(meeting.durationSec)}` : '',
    existingTags?.length ? `기존 태그 목록(재사용 권장): ${existingTags.slice(0, 80).join(', ')}` : '',
    meeting.notes ? `사용자 메모: ${meeting.notes}` : '',
    partInfo || '',
  ].filter(Boolean).join('\n');
  return `${ctx}\n\n=== 전사본 ===\n${transcript}`;
}

export function normalizeMinutes(m) {
  const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  const ai = (x) => arr(x).map((a) => (typeof a === 'string' ? { owner: '', task: a, due: '' } : { owner: a.owner || a.who || '', task: a.task || a.what || '', due: a.due || a.when || '' })).filter((a) => a.task);
  const topics = arr(m.topics).map((t) => ({
    title: t.title || t.name || '주제', tag: cleanTag(t.tag || t.title || ''), time_range: t.time_range || '', summary: t.summary || '',
    key_points: arr(t.key_points).map(String), decisions: arr(t.decisions).map(String), action_items: ai(t.action_items),
  }));
  let actions = ai(m.action_items);
  if (!actions.length) actions = topics.flatMap((t) => t.action_items);
  const tags = [...new Set([...arr(m.tags).map(cleanTag), ...topics.map((t) => t.tag)].filter(Boolean))];
  return {
    title: m.title || '', date: m.date || '', attendees: arr(m.attendees).map(String), overall_summary: m.overall_summary || m.summary || '',
    topics, action_items: actions, open_issues: arr(m.open_issues).map(String), tags, keywords: arr(m.keywords).map(String),
  };
}

export function cleanTag(t) {
  return String(t || '').replace(/^#/, '').replace(/[\s]+/g, ' ').trim().slice(0, 20);
}

/** 회의록 생성 (긴 전사본은 파트별 요약 → 통합) */
export async function generateMinutes(cfg, meeting, existingTags = [], hooks = {}) {
  const P = LLM_PROVIDERS[cfg.provider];
  const maxChars = cfg.maxInputChars || P.maxInputChars;
  const transcript = formatTranscript(meeting);
  if (!transcript.trim()) throw new Error('전사본이 비어 있습니다');
  const parts = splitTranscript(transcript, maxChars);
  const sys = { role: 'system', content: minutesSystemPrompt() };
  if (parts.length === 1) {
    const out = await chat(cfg, [sys, { role: 'user', content: userMsg(meeting, transcript, existingTags) }], { json: true, hooks });
    return normalizeMinutes(extractJson(out));
  }
  const partials = [];
  for (let i = 0; i < parts.length; i++) {
    hooks.onStep && hooks.onStep(`긴 회의: 파트 ${i + 1}/${parts.length} 요약 중`);
    const out = await chat(cfg, [sys, { role: 'user', content: userMsg(meeting, parts[i], existingTags, `※ 전체 회의의 ${i + 1}/${parts.length} 번째 부분입니다. 이 부분만 정리하세요.`) }], { json: true, hooks });
    partials.push(normalizeMinutes(extractJson(out)));
  }
  hooks.onStep && hooks.onStep('파트 요약 통합 중');
  const merge = `아래는 하나의 긴 회의를 ${parts.length}개 부분으로 나눠 각각 정리한 JSON입니다. 같은 주제는 합치고 시간순을 유지하여 하나의 최종 회의록 JSON(같은 스키마)으로 통합하세요.\n\n${partials.map((p, i) => `--- 부분 ${i + 1} ---\n${JSON.stringify(p)}`).join('\n')}`;
  const out = await chat(cfg, [sys, { role: 'user', content: merge }], { json: true, hooks });
  return normalizeMinutes(extractJson(out));
}

/** 주제(태그)별 여러 회의 종합 요약 → 마크다운 */
export async function generateTopicRollup(cfg, tag, meetings, hooks = {}) {
  const items = meetings
    .slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map((m) => {
      const mm = m.minutes || {};
      const rel = (mm.topics || []).filter((t) => t.tag === tag || (m.tags || []).includes(tag));
      const topics = rel.length ? rel : mm.topics || [];
      return `### ${(m.date || '').slice(0, 10)} · ${m.title}\n요약: ${mm.overall_summary || ''}\n${topics.map((t) => `- [${t.title}] ${t.summary}\n  결정: ${(t.decisions || []).join(' / ') || '없음'}\n  할 일: ${(t.action_items || []).map((a) => `${a.owner || '미정'}-${a.task}${a.due ? `(${a.due})` : ''}`).join(' / ') || '없음'}`).join('\n')}`;
    }).join('\n\n');
  const maxChars = cfg.maxInputChars || LLM_PROVIDERS[cfg.provider].maxInputChars;
  const sys = `당신은 여러 회의록을 주제별로 종합하는 한국어 비서입니다. 주어진 주제 "${tag}"에 관해 여러 회의의 내용을 종합해 마크다운으로 작성하세요.
형식:
## 한눈에 보기 (3~5문장)
## 경과 (날짜순 핵심 흐름, 회의별 1~3줄)
## 누적 결정사항
## 진행 중/미완료 할 일 (담당자 · 내용 · 기한)
## 미해결 쟁점 및 다음 논의 제안
없는 내용을 지어내지 말고, 날짜를 명시하세요.`;
  const out = await chat(cfg, [{ role: 'system', content: sys }, { role: 'user', content: items.slice(-maxChars) }], { hooks, temperature: 0.3 });
  return out.trim();
}

/** 보관함 질의응답 (검색 결과를 근거로) */
export async function askArchive(cfg, question, meetings, hooks = {}) {
  const maxChars = cfg.maxInputChars || LLM_PROVIDERS[cfg.provider].maxInputChars;
  let ctx = '';
  for (const m of meetings) {
    const block = `### ${(m.date || '').slice(0, 10)} · ${m.title}\n${m.minutesMd || ''}\n`;
    if (ctx.length + block.length > maxChars) break;
    ctx += block + '\n';
  }
  const sys = '당신은 사용자의 회의록 보관함을 근거로 답하는 한국어 비서입니다. 제공된 회의록에 근거해서만 답하고, 근거 회의(날짜·제목)를 함께 밝히세요. 근거가 없으면 모른다고 답하세요.';
  return (await chat(cfg, [{ role: 'system', content: sys }, { role: 'user', content: `질문: ${question}\n\n=== 회의록 ===\n${ctx}` }], { hooks, temperature: 0.2 })).trim();
}
