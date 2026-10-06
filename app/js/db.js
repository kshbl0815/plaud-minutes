// IndexedDB 저장소 (오프라인 우선, Drive는 동기화 대상)
const DB_NAME = 'plaud-minutes';
const VER = 1;
let _db;

export function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('meetings')) db.createObjectStore('meetings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('topics')) db.createObjectStore('topics', { keyPath: 'tag' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => { _db = r.result; resolve(_db); };
    r.onerror = () => reject(r.error);
  });
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  get: (store, key) => tx(store, 'readonly', (s) => req(s.get(key))),
  all: (store) => tx(store, 'readonly', (s) => req(s.getAll())),
  put: (store, val) => tx(store, 'readwrite', (s) => req(s.put(val))),
  del: (store, key) => tx(store, 'readwrite', (s) => req(s.delete(key))),
  clear: (store) => tx(store, 'readwrite', (s) => req(s.clear())),
};

export async function kvGet(k, dflt = null) { const r = await db.get('kv', k); return r ? r.v : dflt; }
export async function kvSet(k, v) { return db.put('kv', { k, v }); }

export function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** 저장 시 임시 필드(_doc 등) 제거 */
export function stripTransient(m) {
  const o = {};
  for (const [k, v] of Object.entries(m)) if (!k.startsWith('_')) o[k] = v;
  return o;
}
export async function saveMeeting(m, { touch = true } = {}) {
  if (touch) m.updatedAt = Date.now();
  delete m._doc;
  await db.put('meetings', stripTransient(m));
  return m;
}
