// Almacenamiento del fichero SQLite en IndexedDB (navegador / PWA en iPhone).
// Interfaz: { load(): Promise<Uint8Array|null>, save(bytes): Promise<void> }

const DB_NAME = 'gastos-app';
const STORE = 'archivos';
const KEY = 'gastos.sqlite';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloqueada por otra pestaña de la app.'));
  });
}

function tx(idb, mode, op) {
  return new Promise((resolve, reject) => {
    const t = idb.transaction(STORE, mode);
    const req = op(t.objectStore(STORE));
    let value;
    req.onsuccess = () => { value = req.result; };
    // Se resuelve en oncomplete (no en onsuccess): solo entonces el dato está realmente escrito.
    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Transacción IndexedDB abortada (¿almacenamiento lleno?).'));
  });
}

export function createIdbStorage() {
  let idbPromise = null;
  const idb = () => (idbPromise ??= openIdb());

  return {
    async load() {
      const value = await tx(await idb(), 'readonly', (s) => s.get(KEY));
      return value ? new Uint8Array(value) : null;
    },
    async save(bytes) {
      await tx(await idb(), 'readwrite', (s) => s.put(bytes, KEY));
    },
  };
}

/**
 * Pide al navegador que no borre los datos por falta de espacio o inactividad.
 * En iPhone, además, la app DEBE estar añadida a la pantalla de inicio: Safari puede
 * borrar el almacenamiento de webs no visitadas en 7 días, pero no el de apps instaladas.
 * Devuelve true si el almacenamiento queda marcado como persistente.
 */
export async function solicitarPersistencia() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
