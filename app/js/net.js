// 재시도/레이트리밋 처리 fetch
export class RateLimitError extends Error {
  constructor(msg, waitSec) { super(msg); this.name = 'RateLimitError'; this.waitSec = waitSec; }
}
export class ApiError extends Error {
  constructor(msg, status, body) { super(msg); this.name = 'ApiError'; this.status = status; this.body = body; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseRetryAfter(res) {
  const h = res.headers.get('retry-after');
  if (h) {
    const n = Number(h);
    if (!Number.isNaN(n)) return n;
    const d = Date.parse(h);
    if (!Number.isNaN(d)) return Math.max(0, (d - Date.now()) / 1000);
  }
  // Groq: x-ratelimit-reset-* 예: "2m59.56s", "7.66s"
  for (const k of ['x-ratelimit-reset-audio-seconds', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const v = res.headers.get(k);
    if (v) {
      const m = v.match(/(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?/);
      if (m) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    }
  }
  return null;
}

/**
 * makeReq: 매 시도마다 새 RequestInit 생성 (FormData 재사용 문제 방지)
 * maxInlineWaitSec: 이보다 긴 대기가 필요하면 RateLimitError로 일시정지
 */
export async function fetchRetry(url, makeReq, { retries = 4, maxInlineWaitSec = 90, onWait, sleepFn = sleep } = {}) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, makeReq());
    } catch (e) {
      if (attempt >= retries) throw new ApiError(`네트워크 오류: ${e.message}`, 0);
      const w = Math.min(60, 2 ** attempt * 2);
      onWait && onWait(w, '네트워크 재시도');
      await sleepFn(w * 1000); attempt++; continue;
    }
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    if (res.status === 429 || res.status >= 500) {
      const ra = parseRetryAfter(res);
      const w = ra ?? Math.min(60, 2 ** attempt * 3);
      if (res.status === 429 && w > maxInlineWaitSec) throw new RateLimitError(`사용 한도 초과 (약 ${Math.ceil(w / 60)}분 후 다시 시도 가능)`, w);
      if (attempt >= retries) {
        if (res.status === 429) throw new RateLimitError('사용 한도 초과 (잠시 후 다시 시도)', w);
        throw new ApiError(`서버 오류 ${res.status}: ${body.slice(0, 300)}`, res.status, body);
      }
      onWait && onWait(w, res.status === 429 ? '한도 대기' : '서버 재시도');
      await sleepFn(w * 1000); attempt++; continue;
    }
    let msg = body;
    try { const j = JSON.parse(body); msg = j.error?.message || j.message || j.detail || body; } catch {}
    if (res.status === 401 || res.status === 403) throw new ApiError(`API 키 인증 실패 (${res.status}): ${String(msg).slice(0, 200)}`, res.status, body);
    if (res.status === 413) throw new ApiError('파일이 너무 큽니다 (413). 설정에서 청크 길이를 줄여 주세요.', 413, body);
    throw new ApiError(`요청 실패 ${res.status}: ${String(msg).slice(0, 300)}`, res.status, body);
  }
}
