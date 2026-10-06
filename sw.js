// オフラインでも本棚を開けるようにする。更新を確実に届けるため、自サイトのファイルは「ネット優先・失敗したらキャッシュ」
const CACHE = 'yomiage-v2';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/text.js',
  'js/extract.js',
  'js/x-article.js',
  'js/drive.js',
  'js/player.js',
  'js/settings.js',
  'js/audio-util.js',
  'js/engines/speech.js',
  'js/engines/cloud.js',
  'vendor/Readability.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          // ?url=… などのクエリ付きでも同じキーで保存する
          caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./')),
      ),
  );
});
