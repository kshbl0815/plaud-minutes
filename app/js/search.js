// 클라이언트 측 전문 검색 (한국어 조사/어미 대응: 부분 문자열 매칭 + 필드 가중치)
import { esc } from './minutes.js';
import { transcriptText } from './stt.js';

export function normalize(s) {
  return String(s || '').normalize('NFC').toLowerCase();
}

export function parseQuery(q) {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q || ''))) {
    let t = normalize(m[1] || m[2]);
    let neg = false;
    if (!m[1] && t.startsWith('-') && t.length > 1) { neg = true; t = t.slice(1); }
    if (t) terms.push({ t, neg });
  }
  return terms;
}

export function buildDoc(m) {
  const mm = m.minutes || {};
  return {
    title: normalize(m.title),
    tags: normalize((m.tags || []).join(' ')),
    minutes: normalize([m.minutesMd || '', (mm.keywords || []).join(' '), m.notes || ''].join('\n')),
    transcriptRaw: transcriptText(m, { withTime: false }),
  };
}

const W = { title: 10, tags: 8, minutes: 3, transcript: 1 };

function count(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; if (n > 50) break; }
  return n;
}

/** meetings: 배열, 반환: [{meeting, score, snippet(html)}] 점수순 */
export function search(meetings, q, { tag = null } = {}) {
  const terms = parseQuery(q);
  const pos = terms.filter((x) => !x.neg), neg = terms.filter((x) => x.neg);
  const res = [];
  for (const m of meetings) {
    if (m.deleted) continue;
    if (tag && !(m.tags || []).includes(tag)) continue;
    if (!pos.length && !neg.length) { res.push({ meeting: m, score: 0, snippet: '' }); continue; }
    const d = m._doc || (m._doc = buildDoc(m));
    const tr = d.transcript || (d.transcript = normalize(d.transcriptRaw));
    let score = 0, ok = true;
    for (const { t } of pos) {
      const s = count(d.title, t) * W.title + count(d.tags, t) * W.tags + count(d.minutes, t) * W.minutes + Math.min(10, count(tr, t)) * W.transcript;
      if (!s) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    if (neg.some(({ t }) => d.title.includes(t) || d.tags.includes(t) || d.minutes.includes(t) || tr.includes(t))) continue;
    res.push({ meeting: m, score, snippet: makeSnippet(m, pos.map((x) => x.t)) });
  }
  res.sort((a, b) => b.score - a.score || (b.meeting.date || '').localeCompare(a.meeting.date || ''));
  return res;
}

export function highlight(text, terms) {
  let html = esc(text);
  for (const t of terms) {
    if (!t) continue;
    const e = esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(e, 'gi'), (x) => `<mark>${x}</mark>`);
  }
  return html;
}

export function makeSnippet(m, terms, radius = 60) {
  const sources = [m.minutesMd || '', m._doc?.transcriptRaw || transcriptText(m, { withTime: false })];
  for (const src of sources) {
    const low = normalize(src);
    for (const t of terms) {
      const i = low.indexOf(t);
      if (i >= 0) {
        const a = Math.max(0, i - radius), b = Math.min(src.length, i + t.length + radius);
        const piece = (a > 0 ? '…' : '') + src.slice(a, b).replace(/\s+/g, ' ').replace(/[#*]/g, '') + (b < src.length ? '…' : '');
        return highlight(piece, terms);
      }
    }
  }
  return '';
}

/** 태그별 회의 수 */
export function tagCounts(meetings) {
  const map = new Map();
  for (const m of meetings) if (!m.deleted) for (const t of m.tags || []) map.set(t, (map.get(t) || 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
