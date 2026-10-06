// 오디오 분석/분할 모듈 (DOM 비의존: Node 테스트 가능, decode 경로만 브라우저 필요)
// 전략:
//  1) 프로바이더 한도 내면 원본 그대로 전송 (재인코딩 없음)
//  2) MP3: 프레임 헤더를 파싱해 프레임 경계에서 바이트 단위로 자름 (디코딩/재인코딩 없음, 빠르고 메모리 적음)
//  3) WAV/기타: 16kHz 모노 PCM으로 변환 후, 목표 길이 근처의 "가장 조용한 지점"에서 잘라 WAV 청크 생성

export const TARGET_SR = 16000;

const MP3_BITRATES = {
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
  v2l3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
};
const MP3_SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export async function readHead(blob, n) {
  return new Uint8Array(await blob.slice(0, n).arrayBuffer());
}

export function sniffFormat(head, name = '', mime = '') {
  const s = (a, b) => String.fromCharCode(...head.slice(a, b));
  if (head.length >= 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'wav';
  if (head.length >= 3 && s(0, 3) === 'ID3') return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe6) === 0xe2) return 'mp3'; // Layer III sync
  if (head.length >= 4 && s(0, 4) === 'OggS') return 'ogg';
  if (head.length >= 4 && s(0, 4) === 'fLaC') return 'flac';
  if (head.length >= 8 && s(4, 8) === 'ftyp') return 'm4a';
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['mp3', 'wav', 'm4a', 'mp4', 'aac', 'ogg', 'opus', 'flac', 'webm', 'amr', '3gp'].includes(ext)) return ext === 'mp4' ? 'm4a' : ext;
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  return 'unknown';
}

export function parseMp3Header(b0, b1, b2, b3) {
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const ver = (b1 >> 3) & 3; // 0=2.5, 2=2, 3=1
  const layer = (b1 >> 1) & 3; // 1 = Layer III
  if (ver === 1 || layer !== 1) return null;
  const brIdx = (b2 >> 4) & 15;
  const srIdx = (b2 >> 2) & 3;
  const pad = (b2 >> 1) & 1;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const br = (ver === 3 ? MP3_BITRATES.v1l3 : MP3_BITRATES.v2l3)[brIdx] * 1000;
  const sr = MP3_SR[ver][srIdx];
  const samples = ver === 3 ? 1152 : 576;
  const size = Math.floor(((ver === 3 ? 144 : 72) * br) / sr) + pad;
  const mono = ((b3 >> 6) & 3) === 3;
  return { size, sr, samples, br, ver, mono };
}

function id3Size(h) {
  if (h.length < 10 || h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) return 0;
  const sz = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f);
  return 10 + sz + (h[5] & 0x10 ? 10 : 0);
}

/** MP3 프레임 인덱스 생성 (블록 단위로 읽어서 메모리 절약) */
export async function scanMp3(blob, onProgress) {
  const head = await readHead(blob, 10);
  let pos = id3Size(head);
  const offsets = [];
  const sizes = [];
  let samplesPerFrame = 0, sr = 0, totalSamples = 0, firstChecked = false;
  const BLOCK = 4 * 1024 * 1024;
  let buf = new Uint8Array(0), bufStart = pos;
  const total = blob.size;
  let resyncs = 0;
  while (pos + 4 <= total) {
    if (pos + 4 > bufStart + buf.length) {
      buf = new Uint8Array(await blob.slice(pos, Math.min(total, pos + BLOCK)).arrayBuffer());
      bufStart = pos;
      onProgress && onProgress(pos / total);
    }
    const i = pos - bufStart;
    const h = parseMp3Header(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
    if (!h || h.size < 24) {
      pos++; resyncs++;
      if (resyncs > 1024 * 1024 && offsets.length === 0) break; // MP3 아님
      continue;
    }
    if (!firstChecked) {
      firstChecked = true;
      // Xing/Info/VBRI 헤더 프레임은 전체 길이 정보를 담고 있어 분할 시 혼동 → 제외
      const frame = new Uint8Array(await blob.slice(pos, pos + Math.min(h.size, 200)).arrayBuffer());
      const txt = String.fromCharCode(...frame);
      if (txt.includes('Xing') || txt.includes('Info') || txt.includes('VBRI')) { pos += h.size; continue; }
    }
    offsets.push(pos);
    sizes.push(h.size);
    samplesPerFrame = h.samples; sr = h.sr;
    totalSamples += h.samples;
    pos += h.size;
  }
  if (!offsets.length) return null;
  return { offsets, sizes, samplesPerFrame, sr, duration: totalSamples / sr, frameDur: samplesPerFrame / sr };
}

/** 프레임 인덱스로 청크 계획 (바이트/시간 한도 모두 만족, 가능하면 균등 분할해 자투리 청크 방지) */
export function planMp3Chunks(idx, { maxBytes, maxSec }) {
  const N = idx.offsets.length;
  const totalBytes = idx.offsets[N - 1] + idx.sizes[N - 1] - idx.offsets[0];
  // 시간 한도는 2% 여유 허용(자투리 청크 방지), 바이트 한도는 엄격
  const n = Math.max(1, Math.ceil((N * idx.frameDur) / maxSec - 0.02), Math.ceil(totalBytes / maxBytes));
  const even = [];
  for (let k = 0; k < n; k++) even.push(mkMp3Chunk(idx, Math.round((k * N) / n), Math.round(((k + 1) * N) / n)));
  if (even.every((c) => c.endByte - c.startByte <= maxBytes && c.end - c.start <= maxSec * 1.03)) return even;
  // VBR 등으로 균등 분할이 한도를 넘으면 탐욕적 분할
  const chunks = [];
  let startI = 0, bytes = 0;
  for (let i = 0; i < N; i++) {
    const dur = (i - startI + 1) * idx.frameDur;
    if (i > startI && (bytes + idx.sizes[i] > maxBytes || dur > maxSec)) {
      chunks.push(mkMp3Chunk(idx, startI, i));
      startI = i; bytes = 0;
    }
    bytes += idx.sizes[i];
  }
  chunks.push(mkMp3Chunk(idx, startI, N));
  return chunks;
}
function mkMp3Chunk(idx, a, b) {
  const last = b - 1;
  return {
    kind: 'mp3',
    startByte: idx.offsets[a],
    endByte: idx.offsets[last] + idx.sizes[last],
    start: a * idx.frameDur,
    end: b * idx.frameDur,
  };
}

// ---------------- WAV ----------------
export async function parseWav(blob) {
  const head = await readHead(blob, Math.min(blob.size, 1 << 16));
  const dv = new DataView(head.buffer);
  const s = (o) => String.fromCharCode(head[o], head[o + 1], head[o + 2], head[o + 3]);
  if (s(0) !== 'RIFF' || s(8) !== 'WAVE') return null;
  let o = 12, fmt = null;
  while (o + 8 <= head.length) {
    const id = s(o), size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      let format = dv.getUint16(o + 8, true);
      const channels = dv.getUint16(o + 10, true);
      const sampleRate = dv.getUint32(o + 12, true);
      const bits = dv.getUint16(o + 22, true);
      if (format === 0xfffe && size >= 40) format = dv.getUint16(o + 32, true); // EXTENSIBLE
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      if (!fmt) return null;
      let dataSize = size;
      if (dataSize === 0 || dataSize === 0xffffffff || o + 8 + dataSize > blob.size) dataSize = blob.size - (o + 8);
      const blockAlign = fmt.channels * (fmt.bits / 8);
      return { ...fmt, dataOffset: o + 8, dataSize, blockAlign, duration: dataSize / blockAlign / fmt.sampleRate };
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

/** 다운믹스 + 16kHz 리샘플 (구간 평균 필터 → 간단한 안티앨리어싱) */
export function resampleMono(chs, srcRate, dstRate = TARGET_SR) {
  const n = chs[0].length;
  let mono = chs[0];
  if (chs.length > 1) {
    mono = new Float32Array(n);
    for (const c of chs) for (let i = 0; i < n; i++) mono[i] += c[i] / chs.length;
  }
  if (srcRate === dstRate) return Float32Array.from(mono);
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(n / ratio);
  const out = new Float32Array(outLen);
  if (ratio > 1) {
    for (let j = 0; j < outLen; j++) {
      const a = Math.floor(j * ratio), b = Math.min(n, Math.floor((j + 1) * ratio));
      let sum = 0;
      for (let k = a; k < b; k++) sum += mono[k];
      out[j] = b > a ? sum / (b - a) : mono[a] || 0;
    }
  } else {
    for (let j = 0; j < outLen; j++) {
      const x = j * ratio, a = Math.floor(x), f = x - a;
      out[j] = (mono[a] || 0) * (1 - f) + (mono[a + 1] ?? mono[a] ?? 0) * f;
    }
  }
  return out;
}

function decodePcm(bytes, wav) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = Math.floor(bytes.byteLength / wav.blockAlign);
  const chs = Array.from({ length: wav.channels }, () => new Float32Array(frames));
  const bps = wav.bits / 8;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < wav.channels; c++) {
      const o = i * wav.blockAlign + c * bps;
      let v;
      if (wav.format === 3) v = bps === 8 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
      else if (bps === 2) v = dv.getInt16(o, true) / 32768;
      else if (bps === 3) { let x = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16); if (x & 0x800000) x |= ~0xffffff; v = x / 8388608; }
      else if (bps === 4) v = dv.getInt32(o, true) / 2147483648;
      else v = (bytes[o] - 128) / 128;
      chs[c][i] = v;
    }
  }
  return chs;
}

/** PCM 소스 인터페이스: { duration, read(startSec, endSec) -> Float32Array @16kHz mono } */
export function wavSource(blob, wav) {
  return {
    duration: wav.duration,
    async read(a, b) {
      const fa = Math.max(0, Math.floor(a * wav.sampleRate)), fb = Math.min(Math.floor(b * wav.sampleRate), Math.floor(wav.dataSize / wav.blockAlign));
      if (fb <= fa) return new Float32Array(0);
      const bytes = new Uint8Array(await blob.slice(wav.dataOffset + fa * wav.blockAlign, wav.dataOffset + fb * wav.blockAlign).arrayBuffer());
      return resampleMono(decodePcm(bytes, wav), wav.sampleRate);
    },
  };
}

export function bufferSource(mono16k) {
  return {
    duration: mono16k.length / TARGET_SR,
    async read(a, b) { return mono16k.subarray(Math.floor(a * TARGET_SR), Math.min(mono16k.length, Math.floor(b * TARGET_SR))); },
  };
}

/** 목표 지점 직전 searchSec 구간에서 가장 조용한 100ms 프레임 중심을 찾음 */
export function findQuietPoint(samples, sr = TARGET_SR, frameMs = 100) {
  const fl = Math.floor((sr * frameMs) / 1000);
  let best = -1, bestE = Infinity;
  const nFrames = Math.floor(samples.length / fl);
  for (let f = 0; f < nFrames; f++) {
    let e = 0;
    for (let i = f * fl; i < (f + 1) * fl; i++) e += samples[i] * samples[i];
    // 동점이면 뒤쪽(목표에 가까운 쪽) 선호
    if (e <= bestE) { bestE = e; best = f; }
  }
  return best < 0 ? samples.length / sr : (best * fl + fl / 2) / sr;
}

export async function planPcmChunks(src, { maxSec, searchSec = 20 }) {
  const chunks = [];
  let start = 0;
  const D = src.duration;
  const target = D / Math.max(1, Math.ceil(D / maxSec - 0.02));
  while (start < D - 0.05) {
    let end = Math.min(start + maxSec, start + target + searchSec / 2);
    if (end >= D - 1) end = D;
    else {
      const ws = Math.max(start + maxSec / 2, end - searchSec);
      const win = await src.read(ws, end);
      end = ws + findQuietPoint(win);
    }
    chunks.push({ kind: 'pcm', start, end });
    start = end;
  }
  return chunks;
}

export function encodeWav16(samples, sr = TARGET_SR) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** 브라우저 전용: 임의 포맷 디코딩 → 16kHz 모노 */
export async function decodeToMono16k(blob) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw new Error('이 환경에서는 오디오 디코딩을 지원하지 않습니다');
  const ctx = new OAC(1, TARGET_SR, TARGET_SR);
  const ab = await blob.arrayBuffer();
  const audio = await ctx.decodeAudioData(ab);
  const chs = [];
  for (let c = 0; c < audio.numberOfChannels; c++) chs.push(audio.getChannelData(c));
  return resampleMono(chs, audio.sampleRate);
}

/**
 * 오디오 준비: 포맷 판별 → 분할 계획
 * limits: { maxBytes, maxSec }  (maxSec=0 → 시간 제한 없음)
 * 반환: { format, duration, chunks:[{kind,start,end,startByte?,endByte?}], source? }
 */
export async function prepareAudio(blob, name, mime, limits, onProgress) {
  const head = await readHead(blob, 64);
  const format = sniffFormat(head, name, mime);
  const maxSec = limits.maxSec > 0 ? limits.maxSec : Infinity;
  let duration = 0;

  if (format === 'mp3') {
    const idx = await scanMp3(blob, onProgress);
    if (idx) {
      duration = idx.duration;
      if (blob.size <= limits.maxBytes && duration <= maxSec) return { format, duration, chunks: [{ kind: 'whole', start: 0, end: duration }] };
      return { format, duration, chunks: planMp3Chunks(idx, { maxBytes: limits.maxBytes - 4096, maxSec }) };
    }
  }
  let src = null;
  if (format === 'wav') {
    const wav = await parseWav(blob);
    if (wav && [1, 3].includes(wav.format)) {
      duration = wav.duration;
      if (blob.size <= limits.maxBytes && duration <= maxSec) return { format, duration, chunks: [{ kind: 'whole', start: 0, end: duration }] };
      src = wavSource(blob, wav);
    }
  }
  if (!src) {
    // 원본 그대로 보낼 수 있으면 디코딩 생략 (길이는 0 → 이후 응답에서 채움)
    if (blob.size <= limits.maxBytes && maxSec === Infinity) return { format, duration: 0, chunks: [{ kind: 'whole', start: 0, end: 0 }] };
    const mono = await decodeToMono16k(blob);
    src = bufferSource(mono);
    duration = src.duration;
  }
  // 16kHz mono 16bit WAV = 32KB/s → 바이트 한도도 시간으로 환산
  const secByBytes = (limits.maxBytes - 1024) / (TARGET_SR * 2);
  const chunkSec = Math.min(maxSec, secByBytes);
  if (duration <= chunkSec) return { format, duration, source: src, chunks: [{ kind: 'pcm', start: 0, end: duration }] };
  const chunks = await planPcmChunks(src, { maxSec: chunkSec });
  return { format, duration, source: src, chunks };
}

/** 계획된 청크 하나를 전송용 Blob으로 */
export async function materializeChunk(blob, prep, chunk, name) {
  const base = (name || 'audio').replace(/\.[^.]+$/, '');
  if (chunk.kind === 'whole') return { blob, filename: name || `audio.${prep.format}` };
  if (chunk.kind === 'mp3') return { blob: new Blob([blob.slice(chunk.startByte, chunk.endByte)], { type: 'audio/mpeg' }), filename: `${base}_${Math.round(chunk.start)}.mp3` };
  const samples = await prep.source.read(chunk.start, chunk.end);
  return { blob: encodeWav16(samples), filename: `${base}_${Math.round(chunk.start)}.wav` };
}
