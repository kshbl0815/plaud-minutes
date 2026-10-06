// Drive 동기화 오케스트레이션 (IndexedDB ↔ Google Drive)
import { db, kvGet, kvSet, stripTransient } from './db.js';
import * as drive from './drive.js';

let running = null;

export function syncRunning() { return !!running; }

export function syncNow(settings, onStatus = () => {}) {
  if (running) return running;
  running = doSync(settings, onStatus).finally(() => { running = null; });
  return running;
}

const extOf = (m) => (m.fileName?.match(/\.([a-z0-9]+)$/i)?.[1] || 'audio').toLowerCase();

async function doSync(settings, onStatus) {
  onStatus('Drive 폴더 확인 중');
  const folderId = await drive.ensureFolder(await kvGet('driveFolderId'));
  await kvSet('driveFolderId', folderId);
  const remote = await drive.listFolder(folderId);
  const local = await db.all('meetings');
  const plan = drive.planSync(local, remote);
  const byId = new Map(local.map((m) => [m.id, m]));
  let pulled = 0, pushed = 0, audioUp = 0;

  for (const p of plan.pull) {
    onStatus(`가져오는 중 ${++pulled}/${plan.pull.length}`);
    const r = await drive.getJson(p.fileId);
    const merged = drive.mergeRemote(byId.get(p.id), r);
    merged.drive = { ...merged.drive, jsonId: p.fileId, audioId: plan.remoteAudio[p.id] || merged.drive?.audioId };
    if (!byId.get(p.id)) merged.audioLocal = false;
    await db.put('meetings', merged);
    byId.set(p.id, merged);
  }
  // 원격 오디오 ID 반영
  for (const [id, fid] of Object.entries(plan.remoteAudio)) {
    const m = byId.get(id);
    if (m && m.drive?.audioId !== fid) { m.drive = { ...(m.drive || {}), audioId: fid }; await db.put('meetings', stripTransient(m)); }
  }
  const pushJson = new Set(plan.pushJson);
  for (const id of plan.pushAudio) {
    const m = byId.get(id);
    const a = await db.get('audio', id);
    if (!a) continue;
    onStatus(`오디오 업로드 ${++audioUp}/${plan.pushAudio.length}`);
    const res = await drive.putLarge(folderId, `a_${id}.${extOf(m)}`, a.blob, m.mime, (p) => onStatus(`오디오 업로드 ${audioUp}/${plan.pushAudio.length} (${Math.round(p * 100)}%)`));
    m.drive = { ...(m.drive || {}), audioId: res.id };
    if (settings.evictAudioAfterUpload && m.status === 'done') { await db.del('audio', id); m.audioLocal = false; }
    m.updatedAt = Date.now();
    await db.put('meetings', stripTransient(m));
    pushJson.add(id);
  }
  for (const id of pushJson) {
    const m = byId.get(id);
    onStatus(`올리는 중 ${++pushed}/${pushJson.size}`);
    const { audioLocal, ...data } = stripTransient(m);
    const res = await drive.putJson(folderId, `m_${id}.json`, data, plan.remoteJson[id] || m.drive?.jsonId, { updatedAt: String(m.updatedAt) });
    m.drive = { ...(m.drive || {}), jsonId: res.id };
    await db.put('meetings', stripTransient(m));
  }
  // 주제 요약
  const tf = remote.find((f) => f.name === 'topics.json');
  const localTopics = await db.all('topics');
  const remoteTopics = tf ? await drive.getJson(tf.id) : [];
  const mergedTopics = drive.mergeTopics(localTopics, remoteTopics);
  for (const t of mergedTopics) await db.put('topics', t);
  if (JSON.stringify(mergedTopics) !== JSON.stringify(remoteTopics)) await drive.putJson(folderId, 'topics.json', mergedTopics, tf?.id);
  await kvSet('lastSync', Date.now());
  onStatus('');
  return { pulled, pushed, audioUp };
}

export async function fetchAudioFromDrive(m) {
  if (!m.drive?.audioId) throw new Error('Drive에 오디오가 없습니다');
  const blob = await drive.getBlob(m.drive.audioId);
  await db.put('audio', { id: m.id, blob: new Blob([blob], { type: m.mime || blob.type }) });
  m.audioLocal = true;
  await db.put('meetings', stripTransient(m));
  return blob;
}

export async function saveSettingsToDrive(settings, keys) {
  const folderId = await drive.ensureFolder(await kvGet('driveFolderId'));
  const remote = await drive.listFolder(folderId);
  const f = remote.find((x) => x.name === 'settings.json');
  await drive.putJson(folderId, 'settings.json', { settings, keys: settings.syncKeys ? keys : null, savedAt: Date.now() }, f?.id);
}
export async function loadSettingsFromDrive() {
  const folderId = await drive.ensureFolder(await kvGet('driveFolderId'));
  const remote = await drive.listFolder(folderId);
  const f = remote.find((x) => x.name === 'settings.json');
  if (!f) throw new Error('Drive에 저장된 설정이 없습니다');
  return drive.getJson(f.id);
}
