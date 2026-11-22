// Cada restricción del esquema: un caso que debe pasar y otro que debe fallar.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedIds, exec } from './helpers.js';
import { LATEST_VERSION } from '../src/db/migrations.js';
import { ValidationError, NotFoundError, ConflictError, BusinessRuleError } from '../src/errors.js';

let db;
let ids;

beforeEach(async () => {
  ({ db } = await freshDb());
  ids = seedIds(db);
});

const insMov = (p) => exec(db, `
  INSERT INTO movimientos (fecha, importe_cent, tipo, categoria_id, meta_id, cuenta_id, nota)
  VALUES ($fecha, $importe, $tipo, $cat, $meta, $cuenta, $nota)`, {
  $fecha: '2026-11-10', $importe: 1000, $tipo: 'gasto', $cat: null, $meta: null, $cuenta: null, $nota: null, ...p,
});

async function crearMeta(nombre = 'iPhone', objetivo = 120000) {
  const { lastId } = await exec(db, 'INSERT INTO metas_ahorro (nombre, objetivo_cent) VALUES ($n, $o)', { $n: nombre, $o: objetivo });
  return lastId;
}

describe('datos iniciales', () => {
  test('versión de esquema, cuenta y categorías sembradas', () => {
    assert.equal(db.schemaVersion, LATEST_VERSION);
    assert.ok(ids.cuenta && ids.super && ids.ocio && ids.nomina);
    assert.equal(db.value("SELECT count(*) FROM categorias WHERE tipo = 'gasto'"), 10);
  });

  test('foreign_keys está activo', () => {
    assert.equal(db.value('PRAGMA foreign_keys'), 1);
  });
});

describe('movimientos: fechas', () => {
  test('fecha válida', async () => {
    await insMov({ $cat: ids.super, $cuenta: ids.cuenta });
    assert.equal(db.value('SELECT count(*) FROM movimientos'), 1);
  });

  for (const fecha of ['2026-02-30', '2026-13-01', '2026-11-1', '10/11/2026', 'hoy', '']) {
    test(`fecha inválida "${fecha}" rechazada`, async () => {
      await assert.rejects(insMov({ $fecha: fecha, $cat: ids.super, $cuenta: ids.cuenta }), ValidationError);
    });
  }

  test('29 de febrero solo en bisiesto', async () => {
    await insMov({ $fecha: '2028-02-29', $cat: ids.super, $cuenta: ids.cuenta });
    await assert.rejects(insMov({ $fecha: '2027-02-29', $cat: ids.super, $cuenta: ids.cuenta }), ValidationError);
  });
});

describe('movimientos: importe y tipo', () => {
  for (const importe of [0, -500]) {
    test(`importe ${importe} rechazado`, async () => {
      await assert.rejects(insMov({ $importe: importe, $cat: ids.super, $cuenta: ids.cuenta }), ValidationError);
    });
  }

  test('STRICT: un importe decimal (float) se rechaza', async () => {
    await assert.rejects(insMov({ $importe: 10.5, $cat: ids.super, $cuenta: ids.cuenta }), ValidationError);
  });

  test('tipo desconocido rechazado', async () => {
    await assert.rejects(insMov({ $tipo: 'transferencia', $cat: ids.super, $cuenta: ids.cuenta }), ValidationError);
  });

  test('gasto sin categoría rechazado', async () => {
    await assert.rejects(insMov({ $cuenta: ids.cuenta }), ValidationError);
  });

  test('gasto sin cuenta rechazado', async () => {
    await assert.rejects(insMov({ $cat: ids.super }), ValidationError);
  });

  test('categoría inexistente → NotFoundError, nunca se inserta', async () => {
    await assert.rejects(insMov({ $cat: 9999, $cuenta: ids.cuenta }), NotFoundError);
    assert.equal(db.value('SELECT count(*) FROM movimientos'), 0);
  });

  test('cuenta inexistente → NotFoundError', async () => {
    await assert.rejects(insMov({ $cat: ids.super, $cuenta: 9999 }), NotFoundError);
  });

  test('gasto con categoría de ingreso rechazado', async () => {
    await assert.rejects(insMov({ $cat: ids.nomina, $cuenta: ids.cuenta }), ValidationError);
  });

  test('cambiar un gasto a ingreso sin cambiar la categoría rechazado', async () => {
    const { lastId } = await insMov({ $cat: ids.super, $cuenta: ids.cuenta });
    await assert.rejects(exec(db, "UPDATE movimientos SET tipo = 'ingreso' WHERE id = $id", { $id: lastId }), ValidationError);
  });

  test('nota de más de 500 caracteres rechazada', async () => {
    await assert.rejects(insMov({ $cat: ids.super, $cuenta: ids.cuenta, $nota: 'x'.repeat(501) }), ValidationError);
  });
});

describe('metas de ahorro', () => {
  test('aporte y retiro dentro del saldo', async () => {
    const meta = await crearMeta();
    await insMov({ $tipo: 'ahorro_aporte', $meta: meta, $importe: 30000 });
    await insMov({ $tipo: 'ahorro_retiro', $meta: meta, $importe: 10000 });
    assert.equal(db.value('SELECT saldo_cent FROM v_saldo_metas WHERE meta_id = $m', { $m: meta }), 20000);
  });

  test('retiro superior al saldo rechazado', async () => {
    const meta = await crearMeta();
    await insMov({ $tipo: 'ahorro_aporte', $meta: meta, $importe: 5000 });
    await assert.rejects(insMov({ $tipo: 'ahorro_retiro', $meta: meta, $importe: 5001 }), BusinessRuleError);
    assert.equal(db.value('SELECT count(*) FROM movimientos'), 1, 'el retiro no debe quedar guardado');
  });

  test('borrar un aporte que ya se retiró rechazado', async () => {
    const meta = await crearMeta();
    const { lastId: aporte } = await insMov({ $tipo: 'ahorro_aporte', $meta: meta, $importe: 5000 });
    await insMov({ $tipo: 'ahorro_retiro', $meta: meta, $importe: 5000 });
    await assert.rejects(exec(db, 'DELETE FROM movimientos WHERE id = $id', { $id: aporte }), BusinessRuleError);
  });

  test('editar a la baja un aporte por debajo de lo retirado rechazado', async () => {
    const meta = await crearMeta();
    const { lastId: aporte } = await insMov({ $tipo: 'ahorro_aporte', $meta: meta, $importe: 5000 });
    await insMov({ $tipo: 'ahorro_retiro', $meta: meta, $importe: 4000 });
    await assert.rejects(
      exec(db, 'UPDATE movimientos SET importe_cent = 3000 WHERE id = $id', { $id: aporte }), BusinessRuleError);
  });

  test('mover un aporte a otra meta valida la meta de origen', async () => {
    const a = await crearMeta('A');
    const b = await crearMeta('B');
    const { lastId: aporte } = await insMov({ $tipo: 'ahorro_aporte', $meta: a, $importe: 5000 });
    await insMov({ $tipo: 'ahorro_retiro', $meta: a, $importe: 5000 });
    await assert.rejects(
      exec(db, 'UPDATE movimientos SET meta_id = $b WHERE id = $id', { $b: b, $id: aporte }), BusinessRuleError);
  });

  test('aporte con categoría rechazado (los movimientos de ahorro van ligados a la meta)', async () => {
    const meta = await crearMeta();
    await assert.rejects(insMov({ $tipo: 'ahorro_aporte', $meta: meta, $cat: ids.super }), ValidationError);
  });

  test('no se puede borrar una meta con movimientos', async () => {
    const meta = await crearMeta();
    await insMov({ $tipo: 'ahorro_aporte', $meta: meta });
    await assert.rejects(exec(db, 'DELETE FROM metas_ahorro WHERE id = $id', { $id: meta }), NotFoundError);
  });

  test('archivar solo con saldo 0', async () => {
    const meta = await crearMeta();
    await insMov({ $tipo: 'ahorro_aporte', $meta: meta, $importe: 100 });
    const archivar = () => exec(db, "UPDATE metas_ahorro SET estado = 'archivada' WHERE id = $id", { $id: meta });
    await assert.rejects(archivar(), BusinessRuleError);
    await insMov({ $tipo: 'ahorro_retiro', $meta: meta, $importe: 100 });
    await archivar();
  });

  test('nombre duplicado (sin distinguir mayúsculas) → ConflictError', async () => {
    await crearMeta('iPhone');
    await assert.rejects(crearMeta('IPHONE'), ConflictError);
  });

  test('objetivo 0 y fecha límite imposible rechazados', async () => {
    await assert.rejects(crearMeta('X', 0), ValidationError);
    await assert.rejects(
      exec(db, "INSERT INTO metas_ahorro (nombre, objetivo_cent, fecha_limite) VALUES ('Y', 100, '2027-02-31')"),
      ValidationError);
  });
});

describe('categorías', () => {
  test('mismo nombre permitido en gasto e ingreso, duplicado en el mismo tipo no', async () => {
    await exec(db, "INSERT INTO categorias (nombre, tipo) VALUES ('Varios', 'gasto')");
    await exec(db, "INSERT INTO categorias (nombre, tipo) VALUES ('Varios', 'ingreso')");
    await assert.rejects(exec(db, "INSERT INTO categorias (nombre, tipo) VALUES ('varios', 'gasto')"), ConflictError);
  });

  test('no se puede cambiar el tipo de una categoría en uso', async () => {
    await insMov({ $cat: ids.ocio, $cuenta: ids.cuenta });
    await assert.rejects(exec(db, "UPDATE categorias SET tipo = 'ingreso' WHERE id = $id", { $id: ids.ocio }), ConflictError);
  });

  test('no se puede borrar una categoría con movimientos', async () => {
    await insMov({ $cat: ids.ocio, $cuenta: ids.cuenta });
    await assert.rejects(exec(db, 'DELETE FROM categorias WHERE id = $id', { $id: ids.ocio }), NotFoundError);
  });

  test('nombre vacío o solo espacios rechazado', async () => {
    await assert.rejects(exec(db, "INSERT INTO categorias (nombre, tipo) VALUES ('   ', 'gasto')"), ValidationError);
  });
});

describe('presupuestos', () => {
  const insPres = (p) => exec(db, `
    INSERT INTO presupuestos (categoria_id, desde_mes, limite_cent) VALUES ($cat, $mes, $lim)`,
  { $cat: null, $mes: '2026-11', $lim: 40000, ...p });

  test('un solo límite general por mes (trampa de NULL en UNIQUE)', async () => {
    await insPres({});
    await assert.rejects(insPres({}), ConflictError);
  });

  test('un solo presupuesto por categoría y mes', async () => {
    await insPres({ $cat: ids.ocio });
    await insPres({ $cat: ids.ocio, $mes: '2026-12' });
    await assert.rejects(insPres({ $cat: ids.ocio }), ConflictError);
  });

  test('mes inválido rechazado', async () => {
    for (const mes of ['2026-13', '2026-1', '2026-11-01', 'nov']) {
      await assert.rejects(insPres({ $mes: mes }), ValidationError, mes);
    }
  });

  test('presupuesto sobre categoría de ingreso rechazado', async () => {
    await assert.rejects(insPres({ $cat: ids.nomina }), ValidationError);
  });

  test('límite NULL = "sin límite"; 0 = "nada este mes" (migración 2); negativo no', async () => {
    await insPres({ $lim: null });
    await insPres({ $mes: '2026-12', $lim: 0 });
    await assert.rejects(insPres({ $mes: '2027-01', $lim: -1 }), ValidationError);
  });
});

describe('previsiones', () => {
  test('gasto fijo válido y día fuera de rango rechazado', async () => {
    const ins = (dia) => exec(db, `
      INSERT INTO previsiones (nombre, tipo, categoria_id, importe_cent, dia_mes)
      VALUES ('Alquiler', 'gasto', $c, 65000, $d)`, { $c: db.value("SELECT id FROM categorias WHERE nombre = 'Vivienda'"), $d: dia });
    await ins(1);
    await assert.rejects(ins(32), ValidationError);
  });

  test('previsión de gasto con categoría de ingreso rechazada', async () => {
    await assert.rejects(exec(db, `
      INSERT INTO previsiones (nombre, tipo, categoria_id, importe_cent) VALUES ('X', 'gasto', $c, 100)`,
    { $c: ids.nomina }), ValidationError);
  });
});

describe('índices', () => {
  test('la consulta mensual por categoría usa el índice', () => {
    const plan = db.all(`EXPLAIN QUERY PLAN
      SELECT sum(importe_cent) FROM movimientos
      WHERE categoria_id = 1 AND fecha >= '2026-11-01' AND fecha < '2026-12-01'`);
    assert.match(plan.map((r) => r.detail).join(' '), /ix_mov_categoria_fecha/);
  });
});
