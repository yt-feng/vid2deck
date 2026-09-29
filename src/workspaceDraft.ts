// One local draft. IndexedDB preserves File and bigint values without uploading them.
const DATABASE = 'vid2ppt-workspace';
const STORE = 'drafts';
let connection: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭其他 Vid2PPT 页面后重试。'));
  });
  return connection;
}

export async function readDraft<T>(): Promise<T | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get('latest');
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function writeDraft(value: unknown): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(value, 'latest');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
