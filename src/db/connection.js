// Conexión a SQLite (sql.js) + persistencia + migraciones + transacciones.
//
// sql.js mantiene la BD en memoria. Tras cada transacción confirmada exportamos el
// fichero completo y lo guardamos en el almacenamiento (IndexedDB en el móvil).
// La BD de una persona pesa unos cientos de KB: guardarla entera es simple y barato.
//
// Dependencias inyectadas para poder probar en Node sin navegador:
//   SQL     → módulo devuelto por initSqlJs()
//   storage → { load(): Promise<Uint8Array|null>, save(bytes): Promise<void> }

import { MIGRATIONS, LATEST_VERSION } from './migrations.js';
import { translateSqliteError, StorageError, UsageError } from '../errors.js';

const MIN_SQLITE = [3, 37, 0]; // tablas STRICT

export class Database {
  #db;
  #storage;
  #inTx = false;
  #saveChain = Promise.resolve();

  constructor(db, storage) {
    this.#db = db;
    this.#storage = storage;
    applyPragmas(db);
  }

  /** Abre la BD guardada (o crea una nueva) y aplica las migraciones pendientes. */
  static async open({ SQL, storage }) {
    checkSqliteVersion(SQL);
    let bytes = null;
    try {
      bytes = await storage.load();
    } catch (err) {
      throw new StorageError('No se pudieron leer los datos guardados.', { code: 'storage_load', cause: err });
    }

    let raw;
    try {
      raw = bytes ? new SQL.Database(bytes) : new SQL.Database();
      if (bytes) raw.exec('PRAGMA schema_version'); // fuerza la lectura: detecta un fichero corrupto aquí
    } catch (err) {
      throw new StorageError('Los datos guardados están dañados. Restaura una copia de seguridad.',
        { code: 'storage_corrupt', cause: err });
    }

    const db = new Database(raw, storage);
    const migrated = db.#migrate();
    if (migrated || !bytes) await db.persist();
    return db;
  }

  // ---------------------------------------------------------------- consultas

  /** Devuelve todas las filas como objetos. Parámetros con nombre: { $mes: '2026-11' } o posicionales [..]. */
  all(sql, params = {}) {
    const stmt = this.#prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } catch (err) {
      throw translateSqliteError(err);
    } finally {
      stmt.free();
    }
  }

  /** Primera fila o null. */
  get(sql, params = {}) {
    return this.all(sql, params)[0] ?? null;
  }

  /** Primera columna de la primera fila, o null. */
  value(sql, params = {}) {
    const row = this.get(sql, params);
    return row ? Object.values(row)[0] : null;
  }

  /** INSERT/UPDATE/DELETE. Devuelve { changes, lastId }. Debe ir dentro de transaction(). */
  run(sql, params = {}) {
    if (!this.#inTx) {
      throw new UsageError('run() fuera de transaction(): las escrituras deben ir en una transacción para persistirse.');
    }
    try {
      this.#db.run(sql, params);
      return {
        changes: this.#db.getRowsModified(),
        lastId: this.#db.exec('SELECT last_insert_rowid()')[0].values[0][0],
      };
    } catch (err) {
      throw translateSqliteError(err);
    }
  }

  // ---------------------------------------------------------- transacciones

  /**
   * Ejecuta fn(db) en una transacción: todo o nada.
   * Si fn lanza, se hace ROLLBACK y se relanza el error ya traducido.
   * Si va bien, COMMIT y se persiste. Devuelve lo que devuelva fn.
   * fn es SÍNCRONA a propósito: un await dentro dejaría la transacción abierta
   * mientras otra operación de la UI podría colarse.
   */
  async transaction(fn) {
    if (this.#inTx) throw new UsageError('Transacciones anidadas no soportadas.');
    this.#inTx = true;
    let result;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      result = fn(this);
      if (result instanceof Promise) {
        throw new UsageError('La función de transaction() debe ser síncrona.');
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      try { this.#db.exec('ROLLBACK'); } catch { /* ya revertida por SQLite */ }
      throw translateSqliteError(err);
    } finally {
      this.#inTx = false;
    }
    await this.persist();
    return result;
  }

  // ------------------------------------------------------------ persistencia

  /**
   * Exporta la BD y la guarda. Las llamadas se encadenan para que dos guardados
   * seguidos nunca se pisen (el último en empezar es el último en escribir).
   */
  persist() {
    const job = this.#saveChain.then(async () => {
      const bytes = this.export();
      try {
        await this.#storage.save(bytes);
      } catch (err) {
        throw new StorageError('No se pudieron guardar los cambios en el dispositivo.', { code: 'storage_save', cause: err });
      }
    });
    this.#saveChain = job.catch(() => {}); // un fallo no bloquea guardados posteriores
    return job;
  }

  /**
   * Copia binaria del fichero SQLite.
   * TRAMPA de sql.js: export() cierra y reabre la conexión internamente, lo que
   * resetea PRAGMA foreign_keys a OFF y libera los statements preparados.
   * Por eso se reaplican los PRAGMA justo después.
   */
  export() {
    const bytes = this.#db.export();
    applyPragmas(this.#db);
    return bytes;
  }

  get schemaVersion() {
    return this.value('PRAGMA user_version');
  }

  close() {
    this.#db.close();
  }

  // ---------------------------------------------------------------- interno

  #prepare(sql) {
    try {
      return this.#db.prepare(sql);
    } catch (err) {
      throw translateSqliteError(err);
    }
  }

  #migrate() {
    const current = this.value('PRAGMA user_version');
    if (current > LATEST_VERSION) {
      throw new StorageError(
        'Los datos son de una versión más nueva de la app. Actualiza la app antes de abrirlos.',
        { code: 'version_futura' },
      );
    }
    const pending = MIGRATIONS.filter((m) => m.version > current);
    for (const m of pending) {
      try {
        this.#db.exec('BEGIN IMMEDIATE');
        this.#db.exec(m.sql);
        this.#db.exec(`PRAGMA user_version = ${Number(m.version)}`);
        this.#db.exec('COMMIT');
      } catch (err) {
        try { this.#db.exec('ROLLBACK'); } catch { /* noop */ }
        throw new StorageError(`Falló la migración ${m.version} (${m.nombre}).`, { code: 'migracion', cause: err });
      }
    }
    if (pending.length) {
      const problems = this.all('PRAGMA foreign_key_check');
      if (problems.length) {
        throw new StorageError('La migración dejó referencias rotas.', { code: 'migracion_fk' });
      }
    }
    return pending.length > 0;
  }
}

function applyPragmas(db) {
  db.exec('PRAGMA foreign_keys = ON;');
}

function checkSqliteVersion(SQL) {
  const probe = new SQL.Database();
  try {
    const v = probe.exec('SELECT sqlite_version()')[0].values[0][0];
    const parts = v.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((parts[i] ?? 0) > MIN_SQLITE[i]) return;
      if ((parts[i] ?? 0) < MIN_SQLITE[i]) {
        throw new StorageError(`SQLite ${v} es demasiado antiguo (mínimo ${MIN_SQLITE.join('.')}).`, { code: 'sqlite_version' });
      }
    }
  } finally {
    probe.close();
  }
}
