// 서비스 워커: 앱 셸 캐시 + Web Share Target(오디오 공유 받기)
const VERSION = 'pm-v1';
const SHELL = ['./', './index.html', './styles.css', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
  './js/app.js', './js/audio.js', './js/db.js', './js/drive.js', './js/llm.js', './js/minutes.js', './js/net.js', './js/pipeline.js', './js/search.js', './js/settings.js', './js/stt.js', './js/sync.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function idbPut(files) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('plaud-minutes', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const [n, o] of [['meetings', { keyPath: 'id' }], ['audio', { keyPath: 'id' }], ['inbox', { keyPath: 'id', autoIncrement: true }], ['topics', { keyPath: 'tag' }], ['kv', { keyPath: 'k' }]])
        if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, o);
    };
    r.onsuccess = () => {
      const t = r.result.transaction('inbox', 'readwrite');
      for (const f of files) t.objectStore('inbox').add({ blob: f, name: f.name || 'shared-audio', type: f.type || '', lastModified: f.lastModified || Date.now(), receivedAt: Date.now() });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    };
    r.onerror = () => reject(r.error);
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const files = fd.getAll('audio').filter((f) => f && typeof f !== 'string');
        if (files.length) await idbPut(files);
        return Response.redirect(`./#/import?shared=${files.length}`, 303);
      } catch (err) {
        return Response.redirect(`./#/import?shareError=${encodeURIComponent(err.message)}`, 303);
      }
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // 앱 셸: 네트워크 우선(업데이트 반영), 실패 시 캐시 (오프라인)
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('./'))));
});
