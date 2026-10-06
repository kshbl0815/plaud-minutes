// 설정 + API 키 보관 (키는 기기 내 IndexedDB에 AES-GCM 암호화, 암호키는 추출 불가 CryptoKey)
import { kvGet, kvSet } from './db.js';
import { STT_PROVIDERS } from './stt.js';
import { LLM_PROVIDERS } from './llm.js';

export const DEFAULTS = {
  sttProvider: 'groq',
  llmProvider: 'xai',
  language: 'ko',
  keyterms: '',
  autoProcess: true,
  diarize: true,
  stt: {}, // provider → { model, baseUrl, chunkMin }
  llm: {}, // provider → { model, baseUrl, maxInputChars }
  driveClientId: '',
  autoSync: true,
  syncKeys: false,
  evictAudioAfterUpload: false,
};

export const PRESETS = {
  free: { label: '무료 조합: Groq 음성인식 + Gemini 요약', sttProvider: 'groq', llmProvider: 'gemini' },
  grok: { label: 'Grok 조합: xAI 음성인식(화자구분) + Grok 요약', sttProvider: 'xai', llmProvider: 'xai' },
  mixed: { label: '추천 혼합: Groq 음성인식(무료) + Grok 요약', sttProvider: 'groq', llmProvider: 'xai' },
};

async function cryptoKey() {
  let k = await kvGet('ck');
  if (!k) {
    k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await kvSet('ck', k);
  }
  return k;
}

export async function loadSettings() {
  const s = await kvGet('settings', {});
  return { ...DEFAULTS, ...s, stt: { ...(s.stt || {}) }, llm: { ...(s.llm || {}) } };
}
export async function saveSettings(s) { await kvSet('settings', s); }

/** keys: { groq, xai, gemini, custom_stt, custom_llm } */
export async function loadKeys() {
  const enc = await kvGet('keys');
  if (!enc) return {};
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: enc.iv }, await cryptoKey(), enc.ct);
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { return {}; }
}
export async function saveKeys(keys) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(), new TextEncoder().encode(JSON.stringify(keys)));
  await kvSet('keys', { iv, ct });
}

const keyName = (kind, provider) => (provider === 'custom' ? `custom_${kind}` : provider);

export function sttConfig(s, keys) {
  const p = s.sttProvider, P = STT_PROVIDERS[p], o = s.stt[p] || {};
  const chunkMin = o.chunkMin ?? P.chunkMin;
  return {
    provider: p, apiKey: keys[keyName('stt', p)] || '', baseUrl: o.baseUrl || P.baseUrl, model: o.model || P.model,
    language: s.language, diarize: s.diarize, keyterms: splitTerms(s.keyterms),
    limits: { maxBytes: o.maxBytes || P.maxBytes, maxSec: chunkMin > 0 ? chunkMin * 60 : 0 },
  };
}
export function llmConfig(s, keys) {
  const p = s.llmProvider, P = LLM_PROVIDERS[p], o = s.llm[p] || {};
  return { provider: p, apiKey: keys[keyName('llm', p)] || '', baseUrl: o.baseUrl || P.baseUrl, model: o.model || P.model, maxInputChars: o.maxInputChars || P.maxInputChars };
}
export function splitTerms(s) { return String(s || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean); }
export { keyName };
