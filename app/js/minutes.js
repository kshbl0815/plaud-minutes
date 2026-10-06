// 회의록 JSON → 마크다운 / 안전한 HTML 렌더링
import { fmtTime } from './stt.js';
import { transcriptText } from './stt.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ai = (a) => `${a.owner || '미정'} — ${a.task}${a.due ? ` (기한: ${a.due})` : ''}`;

export function minutesToMarkdown(meeting) {
  const m = meeting.minutes;
  const d = meeting.date ? new Date(meeting.date) : null;
  const L = [];
  L.push(`# ${meeting.title || m?.title || '회의록'}`);
  L.push('');
  L.push(`- 일시: ${d ? d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long', timeStyle: 'short' }) : '-'}`);
  if (meeting.durationSec) L.push(`- 길이: ${fmtTime(meeting.durationSec)}`);
  if (m?.attendees?.length) L.push(`- 참석자: ${m.attendees.join(', ')}`);
  if (meeting.tags?.length) L.push(`- 태그: ${meeting.tags.map((t) => '#' + t.replace(/\s/g, '_')).join(' ')}`);
  if (!m) return L.join('\n') + '\n';
  L.push('', '## 전체 요약', '', m.overall_summary || '-');
  if (m.topics?.length) {
    L.push('', '## 주제별 논의');
    m.topics.forEach((t, i) => {
      L.push('', `### ${i + 1}. ${t.title}${t.time_range ? ` (${t.time_range})` : ''}`, '');
      if (t.summary) L.push(t.summary, '');
      if (t.key_points?.length) { L.push('**주요 내용**'); t.key_points.forEach((p) => L.push(`- ${p}`)); L.push(''); }
      if (t.decisions?.length) { L.push('**결정사항**'); t.decisions.forEach((p) => L.push(`- ✅ ${p}`)); L.push(''); }
      if (t.action_items?.length) { L.push('**할 일**'); t.action_items.forEach((a) => L.push(`- [ ] ${ai(a)}`)); L.push(''); }
    });
  }
  if (m.action_items?.length) { L.push('## 전체 할 일', ''); m.action_items.forEach((a) => L.push(`- [ ] ${ai(a)}`)); L.push(''); }
  if (m.open_issues?.length) { L.push('## 미해결 사항', ''); m.open_issues.forEach((p) => L.push(`- ${p}`)); L.push(''); }
  return L.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

export function exportMarkdown(meeting, { withTranscript = true } = {}) {
  let md = meeting.minutes ? minutesToMarkdown(meeting) : `# ${meeting.title}\n`;
  if (withTranscript && meeting.segments?.length) md += `\n---\n\n## 전사본\n\n${transcriptText(meeting).split('\n').join('  \n')}\n`;
  return md;
}

/** 최소한의 마크다운 → HTML (헤더/목록/체크박스/굵게/문단). 먼저 escape 하므로 XSS 안전 */
export function mdToHtml(md) {
  const lines = esc(md || '').split('\n');
  const out = [];
  let list = false;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*]\s+(.*)$/) || line.match(/^\s*\d+\.\s+(.*)$/);
    if (li) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${inline(li[1].replace(/^\[ \]\s*/, '☐ ').replace(/^\[x\]\s*/i, '☑ '))}</li>`);
      continue;
    }
    if (list) { out.push('</ul>'); list = false; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
    else if (line.trim() === '---') out.push('<hr>');
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}
