// 테스트용 가짜 API 서버 (Groq/OpenAI 호환 STT, xAI STT, Chat Completions, Drive 제외)
// - 업로드된 오디오를 ffprobe로 검사(디코딩 가능 여부/길이) → 30초 간격 가짜 한국어 세그먼트 반환
// - /__config 로 429 주입, /__log 로 요청 기록 조회
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function startMock(port = 0) {
  const log = [];
  const cfg = { fail429: 0, retryAfter: '1', bigWait: false, groqMaxBytes: 25 * 1024 * 1024 };
  let reqNo = 0;
  const server = http.createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': 'retry-after' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const send = (code, obj, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors, ...extra }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/__config') { Object.assign(cfg, JSON.parse(body.toString() || '{}')); return send(200, cfg); }
    if (url.pathname === '/__log') return send(200, log);
    if (url.pathname.endsWith('/models')) return send(200, { data: [{ id: 'mock' }] });
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.includes('bad')) return send(401, { error: { message: 'invalid key' } });

    if (url.pathname.endsWith('/audio/transcriptions') || url.pathname.endsWith('/stt')) {
      const isXai = url.pathname.endsWith('/stt');
      if (cfg.fail429 > 0) { cfg.fail429--; log.push({ path: url.pathname, status: 429 }); return send(429, { error: { message: 'rate limit' } }, cfg.bigWait ? { 'retry-after': '3600' } : { 'retry-after': cfg.retryAfter }); }
      const fd = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body }).formData();
      const file = fd.get('file');
      const fields = {};
      const order = [];
      for (const [k, v] of fd.entries()) { order.push(k); if (typeof v === 'string') fields[k] = fields[k] ? [].concat(fields[k], v) : v; }
      const buf = Buffer.from(await file.arrayBuffer());
      if (!isXai && buf.length > cfg.groqMaxBytes) { log.push({ path: url.pathname, status: 413, size: buf.length }); return send(413, { error: { message: 'too large' } }); }
      const tmp = path.join(os.tmpdir(), `mock_${Date.now()}_${reqNo++}_${file.name}`);
      fs.writeFileSync(tmp, buf);
      let dur;
      try {
        dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmp]).toString().trim());
        // 실제 디코딩 가능 여부 확인 (앞 5초)
        execFileSync('ffmpeg', ['-v', 'error', '-t', '5', '-i', tmp, '-f', 'null', '-']);
      } catch (e) { fs.unlinkSync(tmp); log.push({ path: url.pathname, status: 400, size: buf.length }); return send(400, { error: { message: 'cannot decode audio' } }); }
      fs.unlinkSync(tmp);
      log.push({ path: url.pathname, status: 200, size: buf.length, duration: dur, fields, order, filename: file.name });
      const n = Math.max(1, Math.floor(dur / 30));
      if (isXai) {
        const words = [];
        for (let i = 0; i < n; i++) {
          const t0 = i * 30;
          ['예산', '관련', '논의를', `${i + 1}번째로`, '진행했습니다.'].forEach((w, j) => words.push({ text: w, start: t0 + j * 0.5, end: t0 + j * 0.5 + 0.4, speaker: i % 2 }));
        }
        return send(200, { text: words.map((w) => w.text).join(' '), language: 'ko', duration: dur, words });
      }
      const segments = [];
      for (let i = 0; i < n; i++) segments.push({ start: i * 30, end: i * 30 + 28, text: ` ${i + 1}번째 문장: 다음 달 예산과 출시 일정을 논의했습니다.`, no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1.2 });
      segments.push({ start: dur - 1.5, end: dur, text: ' 시청해 주셔서 감사합니다.', no_speech_prob: 0.9, avg_logprob: -1.5 });
      return send(200, { task: 'transcribe', language: 'korean', duration: dur, text: segments.map((s) => s.text).join(''), segments });
    }

    if (url.pathname.endsWith('/chat/completions')) {
      const j = JSON.parse(body.toString());
      log.push({ path: url.pathname, status: 200, model: j.model, response_format: j.response_format, chars: JSON.stringify(j.messages).length });
      if (cfg.rejectResponseFormat && j.response_format) return send(400, { error: { message: 'response_format is not supported' } });
      const user = j.messages.find((m) => m.role === 'user')?.content || '';
      const isJson = !!j.response_format || /JSON/.test(j.messages[0].content);
      let content;
      if (/주제 "/.test(j.messages[0].content)) content = '## 한눈에 보기\n예산 주제 종합.\n## 누적 결정사항\n- 예산 10% 증액';
      else if (/근거해서만/.test(j.messages[0].content)) content = '예산은 10% 증액으로 결정되었습니다 (2026-10-06 회의).';
      else if (isJson) content = '```json\n' + JSON.stringify({
        title: '분기 예산 및 출시 일정 회의', date: '2026-10-06', attendees: ['김성훈'],
        overall_summary: `전사본 ${user.length}자를 요약했습니다. 예산 증액과 출시 일정을 논의했습니다.`,
        topics: [
          { title: '예산 검토', tag: '예산', time_range: '00:00-05:00', summary: '다음 달 예산 10% 증액안 논의', key_points: ['마케팅비 증가'], decisions: ['10% 증액'], action_items: [{ owner: '김성훈', task: '예산안 작성', due: '10/10' }] },
          { title: '출시 일정', tag: '제품 출시', time_range: '05:00-10:00', summary: '베타 출시 11월 확정', key_points: [], decisions: ['11월 베타'], action_items: [] },
        ],
        action_items: [{ owner: '김성훈', task: '예산안 작성', due: '10/10' }], open_issues: ['디자인 인력'], tags: ['예산', '제품 출시'], keywords: ['예산', '베타'],
      }) + '\n```';
      else content = '응답';
      return send(200, { choices: [{ message: { role: 'assistant', content } }] });
    }
    send(404, { error: { message: 'not found ' + url.pathname } });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, log, cfg })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMock(Number(process.argv[2] || 8787)).then(({ port }) => console.log(`mock api on http://127.0.0.1:${port}`));
}
