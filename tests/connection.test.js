import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/db/connection.js';
import { StorageError, BusinessRuleError } from '../src/errors.js';
import { LATEST_VERSION } from '../src/db/migrations.js';
import { sqlModule, memoryStorage, freshDb, seedIds, exec } from './helpers.js';

describe('apertura y persistencia', () => {
  test('una BD nueva se guarda al crearla', async () => {
    const { storage } = await freshDb();
    assert.equal(storage.saves, 1);
    assert.ok(storage.peek().length > 0);
  });

  test('los datos sobreviven a cerrar y reabrir', async () => {
    const { db, storage } = await freshDb();
    await exec(db, "INSERT INTO metas_ahorro (nombre, objetivo_cent) VALUES ('iPhone', 120000)");
    db.close();
    const reopened = await Database.open({ SQL: await sqlModule(), storage: memoryStorage(storage.peek()) });
    assert.equal(reopened.value("SELECT nombre FROM metas_ahorro"), 'iPhone');
    assert.equal(reopened.schemaVersion, LATEST_VERSION);
  });

  test('reabrir no vuelve a migrar ni duplica los datos iniciales', async () => {
    const { storage } = await freshDb();
    const s2 = memoryStorage(storage.peek());
    const db2 = await Database.open({ SQL: await sqlModule(), storage: s2 });
    assert.equal(db2.value('SELECT count(*) FROM cuentas'), 1);
    assert.equal(s2.saves, 0, 'sin migraciones pendientes no hace falta guardar');
  });

  test('foreign_keys sigue activo después de exportar (trampa de sql.js)', async () => {
    const { db } = await freshDb();
    db.export();
    assert.equal(db.value('PRAGMA foreign_keys'), 1);
  });

  test('fichero corrupto → StorageError claro', async () => {
    const basura = new Uint8Array(4096).fill(7);
    await assert.rejects(
      Database.open({ SQL: await sqlModule(), storage: memoryStorage(basura) }),
      (err) => err instanceof StorageError && err.code === 'storage_corrupt',
    );
  });

  test('datos de una versión futura de la app → no se abren', async () => {
    const { db } = await freshDb();
    // Simulamos una BD creada por una versión más nueva
    const SQL = await sqlModule();
    const raw = new SQL.Database(db.export());
    raw.exec('PRAGMA user_version = 99');
    const bytes = raw.export();
    await assert.rejects(
      Database.open({ SQL, storage: memoryStorage(bytes) }),
      (err) => err.code === 'version_futura',
    );
  });

  test('si falla el guardado se informa con StorageError', async () => {
    const { db, storage } = await freshDb();
    storage.failSave = true;
    await assert.rejects(
      exec(db, "INSERT INTO metas_ahorro (nombre, objetivo_cent) VALUES ('X', 100)"),
      (err) => err instanceof StorageError && err.code === 'storage_save',
    );
    storage.failSave = false;
    await exec(db, "INSERT INTO metas_ahorro (nombre, objetivo_cent) VALUES ('Y', 100)"); // se recupera
  });
});

test('una BD en versión 1 se actualiza a la última conservando sus datos', async () => {
  const SQL = await sqlModule();
  const { MIGRATIONS } = await import('../src/db/migrations.js');
  const raw = new SQL.Database();
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(MIGRATIONS[0].sql);
  raw.exec('PRAGMA user_version = 1');
  raw.exec("INSERT INTO presupuestos (categoria_id, desde_mes, limite_cent) VALUES (7, '2026-11', 20000)");
  const db = await Database.open({ SQL, storage: memoryStorage(raw.export()) });
  assert.equal(db.schemaVersion, LATEST_VERSION);
  assert.equal(db.value('SELECT limite_cent FROM presupuestos'), 20000);
  assert.equal(db.value("SELECT count(*) FROM sqlite_master WHERE name = 'trg_cat_tipo_inmutable'"), 1);
});

describe('transacciones', () => {
  test('si algo falla a mitad, no se guarda nada', async () => {
    const { db, storage } = await freshDb();
    const { cuenta } = seedIds(db);
    const savesAntes = storage.saves;
    await assert.rejects(db.transaction((tx) => {
      const { lastId: meta } = tx.run("INSERT INTO metas_ahorro (nombre, objetivo_cent) VALUES ('iPhone', 1000)");
      tx.run(`INSERT INTO movimientos (fecha, importe_cent, tipo, meta_id, cuenta_id)
              VALUES ('2026-11-01', 500, 'ahorro_retiro', $m, $c)`, { $m: meta, $c: cuenta });
    }), BusinessRuleError);
    assert.equal(db.value('SELECT count(*) FROM metas_ahorro'), 0, 'la meta también se revierte');
    assert.equal(storage.saves, savesAntes, 'no se persiste una transacción fallida');
  });

  test('run() fuera de una transacción está prohibido', async () => {
    const { db } = await freshDb();
    assert.throws(() => db.run("INSERT INTO ajustes (clave) VALUES ('x')"), /fuera de transaction/);
  });

  test('una función async dentro de transaction() se rechaza y se revierte', async () => {
    const { db } = await freshDb();
    await assert.rejects(db.transaction(async (tx) => {
      tx.run("INSERT INTO ajustes (clave, valor) VALUES ('x', '1')");
    }), /síncrona/);
    assert.equal(db.value("SELECT count(*) FROM ajustes WHERE clave = 'x'"), 0);
  });

  test('transaction() devuelve el resultado de la función', async () => {
    const { db } = await freshDb();
    const id = await db.transaction((tx) => tx.run("INSERT INTO cuentas (nombre) VALUES ('Efectivo')").lastId);
    assert.equal(db.value('SELECT nombre FROM cuentas WHERE id = $id', { $id: id }), 'Efectivo');
  });
});
