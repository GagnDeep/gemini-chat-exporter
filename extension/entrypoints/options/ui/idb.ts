// Minimal IndexedDB store for cached embeddings (no external dependency).
// One record per segment: { id, hash, vec }. `hash` lets us invalidate a vector
// when a turn's text changes, so re-scrapes only re-embed what actually moved.

const DB_NAME = "gemini-archive";
const STORE = "embeddings";

export interface EmbRecord {
  id: string;
  hash: string;
  vec: number[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function getAllEmbeddings(): Promise<Map<string, EmbRecord>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const map = new Map<string, EmbRecord>();
      for (const r of req.result as EmbRecord[]) map.set(r.id, r);
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function putEmbeddings(records: EmbRecord[]): Promise<void> {
  if (!records.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const r of records) store.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearEmbeddings(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Drop cached vectors whose segment id is no longer present. */
export async function pruneEmbeddings(validIds: Set<string>): Promise<void> {
  const db = await openDb();
  const all = await getAllEmbeddings();
  const stale = [...all.keys()].filter((id) => !validIds.has(id));
  if (!stale.length) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const id of stale) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
