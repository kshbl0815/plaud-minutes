import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sniffFormat, readHead, scanMp3, planMp3Chunks, parseWav, prepareAudio, materializeChunk, resampleMono, findQuietPoint, encodeWav16 } from '../app/js/audio.js';
import { fileBlob, ffprobeDur, writeTmp, FIX } from './helpers.js';

test('포맷 판별', async () => {
  assert.equal(sniffFormat(await readHead(await fileBlob('long.mp3'), 64)), 'mp3');
  assert.equal(sniffFormat(await readHead(await fileBlob('short.mp3'), 64)), 'mp3'); // ID3 태그
  assert.equal(sniffFormat(await readHead(await fileBlob('gap.wav'), 64)), 'wav');
  assert.equal(sniffFormat(await readHead(await fileBlob('short.m4a'), 64)), 'm4a');
});

test('MP3 프레임 스캔: 길이가 ffprobe와 일치', async () => {
  const idx = await scanMp3(await fileBlob('long.mp3'));
  const ref = ffprobeDur(path.join(FIX, 'long.mp3'));
  assert.ok(Math.abs(idx.duration - ref) < 0.2, `${idx.duration} vs ${ref}`);
  const idx2 = await scanMp3(await fileBlob('short.mp3'));
  assert.ok(Math.abs(idx2.duration - ffprobeDur(path.join(FIX, 'short.mp3'))) < 0.2);
});

test('MP3 분할: 25MB/10분 한도 준수, 각 청크 디코딩 가능, 길이 합 보존', async () => {
  const blob = await fileBlob('long.mp3', 'audio/mpeg');
  const prep = await prepareAudio(blob, 'long.mp3', 'audio/mpeg', { maxBytes: 24 * 1024 * 1024, maxSec: 600 });
  assert.equal(prep.chunks.length, 3);
  let sum = 0;
  for (const c of prep.chunks) {
    const { blob: part, filename } = await materializeChunk(blob, prep, c, 'long.mp3');
    assert.ok(part.size <= 24 * 1024 * 1024);
    assert.ok(c.end - c.start <= 600 * 1.03);
    const p = await writeTmp(part, filename);
    const d = ffprobeDur(p);
    assert.ok(Math.abs(d - (c.end - c.start)) < 0.5, `chunk ${d} vs ${c.end - c.start}`);
    sum += d;
  }
  assert.ok(Math.abs(sum - prep.duration) < 1);
  // 바이트 한도만으로 분할 (시간 무제한)
  const idx = await scanMp3(blob);
  const bc = planMp3Chunks(idx, { maxBytes: 10 * 1024 * 1024, maxSec: Infinity });
  assert.equal(bc.length, 3);
  assert.ok(bc.every((c) => c.endByte - c.startByte <= 10 * 1024 * 1024));
  assert.equal(bc[1].startByte, bc[0].endByte);
});

test('한도 내 파일은 원본 그대로(whole)', async () => {
  const blob = await fileBlob('short.mp3');
  const prep = await prepareAudio(blob, 'short.mp3', 'audio/mpeg', { maxBytes: 24 * 1024 * 1024, maxSec: 600 });
  assert.equal(prep.chunks.length, 1);
  assert.equal(prep.chunks[0].kind, 'whole');
  const xai = await prepareAudio(await fileBlob('long.mp3'), 'long.mp3', '', { maxBytes: 480 * 1024 * 1024, maxSec: 0 });
  assert.equal(xai.chunks[0].kind, 'whole');
});

test('WAV: 16kHz 모노 변환 + 무음 지점에서 분할', async () => {
  const blob = await fileBlob('gap.wav');
  const w = await parseWav(blob);
  assert.equal(w.channels, 2); assert.equal(w.sampleRate, 48000);
  const prep = await prepareAudio(blob, 'gap.wav', 'audio/wav', { maxBytes: 24 * 1024 * 1024, maxSec: 600 });
  assert.equal(prep.chunks.length, 2);
  const cut = prep.chunks[0].end;
  assert.ok(cut >= 356 && cut <= 359, `cut at ${cut}`); // 균등 분할 목표(360초) 근처의 356~359초 무음 구간
  const { blob: part, filename } = await materializeChunk(blob, prep, prep.chunks[0], 'gap.wav');
  assert.ok(part.size < 24 * 1024 * 1024);
  const p = await writeTmp(part, filename);
  assert.ok(Math.abs(ffprobeDur(p) - cut) < 0.1);
});

test('리샘플/무음 탐지/WAV 인코딩 단위', () => {
  const sr = 48000, n = sr;
  const sine = new Float32Array(n).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / sr));
  const out = resampleMono([sine, sine], sr, 16000);
  assert.equal(out.length, 16000);
  const rms = Math.sqrt(out.reduce((a, v) => a + v * v, 0) / out.length);
  assert.ok(rms > 0.6 && rms < 0.75, `rms ${rms}`);
  const sig = new Float32Array(16000 * 10).fill(0.5); sig.fill(0, 16000 * 7, 16000 * 7 + 1600);
  const q = findQuietPoint(sig);
  assert.ok(q > 7 && q < 7.1);
  const wav = encodeWav16(new Float32Array(16000));
  assert.equal(wav.size, 44 + 32000);
});
