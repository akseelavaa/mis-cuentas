import initSqlJs from 'sql.js';
import { Database } from '../src/db/connection.js';

let SQL;
export async function sqlModule() {
  SQL ??= await initSqlJs();
  return SQL;
}

/** Almacenamiento en memoria que imita a IndexedDB. */
export function memoryStorage(initial = null, { failSave = false } = {}) {
  let data = initial;
  return {
    saves: 0,
    failSave,
    async load() { return data; },
    async save(bytes) {
      if (this.failSave) throw new Error('disco lleno');
      data = new Uint8Array(bytes);
      this.saves += 1;
    },
    peek() { return data; },
  };
}

export async function freshDb() {
  const storage = memoryStorage();
  const db = await Database.open({ SQL: await sqlModule(), storage });
  return { db, storage };
}

/** Ids útiles de los datos iniciales. */
export function seedIds(db) {
  const cat = (nombre) => db.value('SELECT id FROM categorias WHERE nombre = $n', { $n: nombre });
  return {
    cuenta: db.value("SELECT id FROM cuentas WHERE nombre = 'Principal'"),
    super: cat('Supermercado'),
    ocio: cat('Ocio'),
    nomina: cat('Nómina'),
  };
}

/** Ejecuta un SQL de escritura en su propia transacción. */
export function exec(db, sql, params) {
  return db.transaction((tx) => tx.run(sql, params));
}

/** "Hoy" fijo para las pruebas de servicios: domingo 22/11/2026 a mediodía (hora local). */
export const HOY = () => new Date(2026, 10, 22, 12, 0);

export async function freshApp() {
  const { createServices } = await import('../src/services/index.js');
  const { db, storage } = await freshDb();
  const app = createServices(db, { now: HOY });
  const cat = (nombre) => db.value('SELECT id FROM categorias WHERE nombre = $n', { $n: nombre });
  return { db, storage, app, cat };
}
