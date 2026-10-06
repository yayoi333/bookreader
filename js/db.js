// IndexedDB（端末内の本棚と音声キャッシュ）
const DB_NAME = 'yomiage';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('docs')) {
          const docs = db.createObjectStore('docs', { keyPath: 'id' });
          docs.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const docs = {
  async all() {
    const list = (await run('docs', 'readonly', (s) => s.getAll())) || [];
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  get: (id) => run('docs', 'readonly', (s) => s.get(id)),
  put: (doc) => run('docs', 'readwrite', (s) => s.put({ ...doc, updatedAt: doc.updatedAt || Date.now() })),
  delete: (id) => run('docs', 'readwrite', (s) => s.delete(id)),
  async findBy(field, value) {
    if (!value) return null;
    return (await docs.all()).find((d) => d[field] === value) || null;
  },
  /** 進み具合だけ更新（並び順は変えない） */
  async setProgress(id, progress) {
    const doc = await docs.get(id);
    if (!doc) return;
    doc.progress = progress;
    doc.readAt = Date.now();
    await run('docs', 'readwrite', (s) => s.put(doc));
  },
};

export const audioCache = {
  async get(key) {
    const row = await run('audio', 'readonly', (s) => s.get(key));
    return row ? row.blob : null;
  },
  put: (key, blob) => run('audio', 'readwrite', (s) => s.put({ key, blob, at: Date.now() })),
  clear: () => run('audio', 'readwrite', (s) => s.clear()),
  async size() {
    const rows = (await run('audio', 'readonly', (s) => s.getAll())) || [];
    return rows.reduce((n, r) => n + (r.blob?.size || 0), 0);
  },
};

export const kv = {
  async get(k, fallback = null) {
    const row = await run('kv', 'readonly', (s) => s.get(k));
    return row ? row.v : fallback;
  },
  set: (k, v) => run('kv', 'readwrite', (s) => s.put({ k, v })),
};
