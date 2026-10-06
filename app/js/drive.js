// Google Drive 동기화 (사용자 본인 Drive, drive.file 범위: 이 앱이 만든 파일만 접근)
// 구조: 내 드라이브/Plaud 회의록/ 안에
//   m_<id>.json  (회의 메타+전사+회의록)   a_<id>.<ext> (원본 오디오)   topics.json   settings.json(선택)
import { fetchRetry } from './net.js';

export const FOLDER_NAME = 'Plaud 회의록';
const API = 'https://www.googleapis.com/drive/v3';
const UP = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

let token = null, tokenExp = 0, tokenClient = null, gisLoaded = null;

export function hasToken() { return token && Date.now() < tokenExp - 60000; }

export function restoreToken() {
  try {
    const t = JSON.parse(localStorage.getItem('gdrive_token') || 'null');
    if (t && Date.now() < t.exp - 60000) { token = t.token; tokenExp = t.exp; }
  } catch {}
  return hasToken();
}

function loadGis() {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((res, rej) => {
    if (globalThis.google?.accounts?.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.onload = () => res(); s.onerror = () => { gisLoaded = null; rej(new Error('Google 로그인 스크립트를 불러오지 못했습니다')); };
    document.head.appendChild(s);
  });
  return gisLoaded;
}

/** 사용자 탭(제스처) 안에서 호출해야 팝업이 열림 */
export async function connect(clientId, { prompt = '' } = {}) {
  if (!clientId) throw new Error('설정에서 Google OAuth 클라이언트 ID를 먼저 입력하세요');
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPE,
      callback: (r) => {
        if (r.error) return reject(new Error(`Google 인증 실패: ${r.error}`));
        token = r.access_token; tokenExp = Date.now() + (r.expires_in || 3600) * 1000;
        localStorage.setItem('gdrive_token', JSON.stringify({ token, exp: tokenExp }));
        resolve(true);
      },
      error_callback: (e) => reject(new Error(`Google 인증 취소/실패: ${e?.type || e}`)),
    });
    tokenClient.requestAccessToken({ prompt });
  });
}
export function disconnect() {
  if (token && globalThis.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  token = null; tokenExp = 0; localStorage.removeItem('gdrive_token');
}

const auth = (extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
async function api(path, init = {}) {
  if (!hasToken()) throw new Error('Google Drive 연결이 만료되었습니다. "Drive 연결"을 다시 눌러 주세요.');
  const res = await fetchRetry(path.startsWith('http') ? path : API + path, () => ({ ...init, headers: auth(init.headers) }), { retries: 3 });
  return res;
}

export async function ensureFolder(cached) {
  if (cached) {
    try { const r = await api(`/files/${cached}?fields=id,trashed`); const j = await r.json(); if (!j.trashed) return cached; } catch {}
  }
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const r = await api(`/files?q=${q}&fields=files(id,name)&spaces=drive`);
  const j = await r.json();
  if (j.files?.length) return j.files[0].id;
  const c = await api('/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }) });
  return (await c.json()).id;
}

export async function listFolder(folderId) {
  const files = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const r = await api(`/files?q=${q}&pageSize=1000&fields=nextPageToken,files(id,name,size,modifiedTime,appProperties)${pageToken ? `&pageToken=${pageToken}` : ''}`);
    const j = await r.json();
    files.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return files;
}

/** 작은 파일(JSON) 업로드/갱신 */
export async function putJson(folderId, name, obj, existingId, appProperties = {}) {
  const meta = existingId ? { appProperties } : { name, parents: [folderId], mimeType: 'application/json', appProperties };
  const boundary = 'pm' + Math.random().toString(36).slice(2);
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj)}\r\n--${boundary}--`;
  const url = existingId ? `${UP}/files/${existingId}?uploadType=multipart&fields=id,modifiedTime` : `${UP}/files?uploadType=multipart&fields=id,modifiedTime`;
  const r = await api(url, { method: existingId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  return r.json();
}

/** 큰 파일(오디오) 재개 가능 업로드: 8MB 단위 */
export async function putLarge(folderId, name, blob, mime, onProgress, appProperties = {}) {
  const init = await api(`${UP}/files?uploadType=resumable&fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime || 'application/octet-stream', 'X-Upload-Content-Length': String(blob.size) },
    body: JSON.stringify({ name, parents: [folderId], appProperties }),
  });
  const loc = init.headers.get('Location');
  if (!loc) throw new Error('Drive 업로드 세션 생성 실패 (CORS로 Location 헤더가 차단되었을 수 있음)');
  const CH = 8 * 1024 * 1024;
  let off = 0, fails = 0;
  while (off < blob.size) {
    const end = Math.min(blob.size, off + CH);
    let res;
    try {
      res = await fetch(loc, { method: 'PUT', headers: { 'Content-Range': `bytes ${off}-${end - 1}/${blob.size}` }, body: blob.slice(off, end) });
    } catch (e) {
      if (++fails > 5) throw e;
      await new Promise((r) => setTimeout(r, 2000 * fails));
      // 서버가 받은 위치 확인
      const st = await fetch(loc, { method: 'PUT', headers: { 'Content-Range': `bytes */${blob.size}` } });
      const rg = st.headers.get('Range');
      off = rg ? Number(rg.split('-')[1]) + 1 : 0;
      continue;
    }
    if (res.status === 308) {
      const rg = res.headers.get('Range');
      off = rg ? Number(rg.split('-')[1]) + 1 : end;
      onProgress && onProgress(off / blob.size);
      continue;
    }
    if (res.ok) { onProgress && onProgress(1); return res.json(); }
    if (res.status >= 500 && ++fails <= 5) { await new Promise((r) => setTimeout(r, 2000 * fails)); continue; }
    throw new Error(`Drive 업로드 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error('Drive 업로드가 완료되지 않았습니다');
}

export async function getJson(id) { return (await api(`/files/${id}?alt=media`)).json(); }
export async function getBlob(id) { return (await api(`/files/${id}?alt=media`)).blob(); }
export async function trash(id) {
  await api(`/files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
}

// ---------------- 동기화 계획 (순수 함수: 테스트 가능) ----------------
/**
 * local: [{id, updatedAt, drive?:{jsonId,audioId}, audioLocal, deleted}]
 * remote: Drive files 목록
 * 반환: { pushJson:[id], pushAudio:[id], pull:[{id,fileId}], remoteAudio:{id:fileId}, remoteJson:{id:fileId} }
 */
export function planSync(local, remote) {
  const rj = {}, ra = {}, rUpd = {};
  for (const f of remote) {
    let m;
    if ((m = f.name.match(/^m_(.+)\.json$/))) { rj[m[1]] = f.id; rUpd[m[1]] = Number(f.appProperties?.updatedAt || 0); }
    else if ((m = f.name.match(/^a_([^.]+)\./))) ra[m[1]] = f.id;
  }
  const L = new Map(local.map((m) => [m.id, m]));
  const pushJson = [], pushAudio = [], pull = [];
  for (const m of local) {
    const ru = rUpd[m.id];
    if (ru == null || m.updatedAt > ru) pushJson.push(m.id);
    else if (ru > m.updatedAt) pull.push({ id: m.id, fileId: rj[m.id] });
    if (!m.deleted && m.audioLocal && !ra[m.id]) pushAudio.push(m.id);
  }
  for (const id of Object.keys(rj)) if (!L.has(id)) pull.push({ id, fileId: rj[id] });
  return { pushJson, pushAudio, pull, remoteAudio: ra, remoteJson: rj };
}

/** 원격 회의 JSON과 로컬 병합 (원격이 더 최신일 때) */
export function mergeRemote(localM, remoteM) {
  return { ...remoteM, audioLocal: localM?.audioLocal || false, drive: { ...(localM?.drive || {}), ...(remoteM.drive || {}) } };
}

export function mergeTopics(localList, remoteList) {
  const map = new Map();
  for (const t of [...(remoteList || []), ...(localList || [])]) {
    const cur = map.get(t.tag);
    if (!cur || (t.updatedAt || 0) > (cur.updatedAt || 0)) map.set(t.tag, t);
  }
  return [...map.values()];
}
