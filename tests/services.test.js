import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp } from './helpers.js';
import {
  ValidationError, NotFoundError, ConflictError, BusinessRuleError,
} from '../src/errors.js';
import { nivelPresupuesto } from '../src/services/presupuestos.js';

let app;
let cat;
let db;

beforeEach(async () => {
  ({ app, cat, db } = await freshApp());
});

const gasto = (categoria, importe, fecha = '2026-11-10', extra = {}) =>
  app.movimientos.crear({ tipo: 'gasto', categoria_id: cat(categoria), importe, fecha, ...extra });
const ingreso = (importe, fecha = '2026-11-01') =>
  app.movimientos.crear({ tipo: 'ingreso', categoria_id: cat('Nómina'), importe, fecha });
const rechaza = (promesa, Clase, code) =>
  assert.rejects(promesa, (e) => e instanceof Clase && (!code || e.code === code));

describe('movimientos: alta', () => {
  test('gasto con texto "12,50", cuenta por defecto y nota recortada', async () => {
    const { movimiento, avisos } = await gasto('Ocio', '12,50', '2026-11-10', { nota: '  cine  ' });
    assert.equal(movimiento.importe_cent, 1250);
    assert.equal(movimiento.cuenta, 'Principal');
    assert.equal(movimiento.nota, 'cine');
    assert.equal(movimiento.categoria, 'Ocio');
    assert.ok(Array.isArray(avisos));
  });

  test('sin fecha → hoy', async () => {
    const { movimiento } = await app.movimientos.crear({ tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '1000' });
    assert.equal(movimiento.fecha, '2026-11-22');
  });

  test('fecha futura: se guarda pero avisa', async () => {
    await ingreso('100');
    const { avisos } = await gasto('Ocio', '5', '2026-12-24');
    assert.ok(avisos.some((a) => a.tipo === 'fecha_futura'));
  });

  test('categoría de otro tipo → ValidationError en el campo categoria_id', async () => {
    await assert.rejects(
      app.movimientos.crear({ tipo: 'gasto', categoria_id: cat('Nómina'), importe: '5' }),
      (e) => e instanceof ValidationError && e.field === 'categoria_id' && /ingreso/.test(e.message),
    );
  });

  test('categoría inexistente → NotFoundError', async () => {
    await rechaza(app.movimientos.crear({ tipo: 'gasto', categoria_id: 999, importe: '5' }), NotFoundError);
  });

  test('categoría archivada no admite nuevos gastos', async () => {
    await app.categorias.activar(cat('Ocio'), false);
    await rechaza(gasto('Ocio', '5'), BusinessRuleError, 'categoria_inactiva');
  });

  test('editar un gasto antiguo de una categoría archivada sí se permite', async () => {
    await ingreso('100');
    const { movimiento } = await gasto('Ocio', '5');
    await app.categorias.activar(cat('Ocio'), false);
    const r = await app.movimientos.editar(movimiento.id, { importe: '6' });
    assert.equal(r.movimiento.importe_cent, 600);
  });

  test('entrada inválida: importe, tipo, fecha, nota', async () => {
    await rechaza(gasto('Ocio', '-5'), ValidationError, 'importe_negativo');
    await rechaza(gasto('Ocio', ''), ValidationError, 'importe_vacio');
    await rechaza(gasto('Ocio', '5', '31/11/2026'), ValidationError, 'fecha_inexistente');
    await rechaza(app.movimientos.crear({ tipo: 'regalo', importe: '5' }), ValidationError);
    await rechaza(gasto('Ocio', '5', '2026-11-10', { nota: 'x'.repeat(501) }), ValidationError);
    assert.equal(db.value('SELECT count(*) FROM movimientos'), 0);
  });

  test('gasto con meta → ValidationError', async () => {
    const meta = await app.metas.crear({ nombre: 'iPhone', objetivo: '1200' });
    await rechaza(gasto('Ocio', '5', '2026-11-10', { meta_id: meta.id }), ValidationError, 'meta_no_aplica');
  });
});

describe('movimientos: avisos de presupuesto y disponible', () => {
  test('aviso al 80 % y superado al pasar el límite', async () => {
    await ingreso('1000');
    await app.presupuestos.definir({ categoria_id: cat('Ocio'), desde_mes: '2026-11', limite: '100' });
    let r = await gasto('Ocio', '79');
    assert.equal(r.avisos.filter((a) => a.tipo === 'presupuesto').length, 0);
    r = await gasto('Ocio', '1');
    assert.equal(r.avisos.find((a) => a.tipo === 'presupuesto').nivel, 'aviso');
    r = await gasto('Ocio', '20,01');
    const aviso = r.avisos.find((a) => a.tipo === 'presupuesto');
    assert.equal(aviso.nivel, 'superado');
    assert.match(aviso.mensaje, /100,01/);
  });

  test('un gasto que deja el disponible en negativo se guarda con aviso', async () => {
    await ingreso('100');
    const { movimiento, avisos } = await gasto('Supermercado', '150');
    assert.ok(movimiento.id);
    const a = avisos.find((x) => x.tipo === 'disponible_negativo');
    assert.match(a.mensaje, /50,00/);
  });
});

describe('metas: aportes y retiros', () => {
  let iphone;
  beforeEach(async () => {
    await ingreso('500');
    iphone = await app.metas.crear({ nombre: 'iPhone', objetivo: '1200', fecha_limite: '2027-03-31' });
  });
  const aporte = (importe, fecha = '2026-11-05') =>
    app.movimientos.crear({ tipo: 'ahorro_aporte', meta_id: iphone.id, importe, fecha });
  const retiro = (importe, fecha = '2026-11-20') =>
    app.movimientos.crear({ tipo: 'ahorro_retiro', meta_id: iphone.id, importe, fecha });

  test('disponible vs reservado', async () => {
    await aporte('300');
    assert.deepEqual(app.saldos.calcular(), { total_cent: 50000, reservado_cent: 30000, disponible_cent: 20000 });
  });

  test('no puedes apartar más de lo disponible', async () => {
    await aporte('300');
    await assert.rejects(aporte('250'), (e) => e.code === 'disponible_insuficiente' && /200,00/.test(e.message));
    assert.equal(app.metas.saldo(iphone.id), 30000);
  });

  test('retiro superior al saldo → mensaje con el saldo real', async () => {
    await aporte('100');
    await assert.rejects(retiro('150'), (e) => e.code === 'saldo_meta_insuficiente' && /100,00/.test(e.message));
  });

  test('retiro con fecha anterior al aporte que lo cubre → rechazado', async () => {
    await aporte('100', '2026-11-15');
    await assert.rejects(retiro('50', '2026-11-10'), (e) => e.code === 'saldo_meta_historico' && /10\/11\/2026/.test(e.message));
  });

  test('aporte y retiro el mismo día: el aporte cuenta primero', async () => {
    await aporte('100', '2026-11-15');
    await retiro('100', '2026-11-15');
    assert.equal(app.metas.saldo(iphone.id), 0);
  });

  test('mover la fecha de un aporte después de su retiro → rechazado', async () => {
    const { movimiento } = await aporte('100', '2026-11-05');
    await retiro('100', '2026-11-10');
    await rechaza(app.movimientos.editar(movimiento.id, { fecha: '2026-11-12' }), BusinessRuleError, 'saldo_meta_historico');
  });

  test('borrar un aporte ya retirado → mensaje claro', async () => {
    const { movimiento } = await aporte('100');
    await retiro('100');
    await rechaza(app.movimientos.eliminar(movimiento.id), BusinessRuleError, 'aporte_ya_retirado');
  });

  test('editar aumentando un aporte por encima del disponible → rechazado', async () => {
    const { movimiento } = await aporte('300');
    await assert.rejects(app.movimientos.editar(movimiento.id, { importe: '600' }),
      (e) => e.code === 'disponible_insuficiente' && /500,00/.test(e.message));
  });

  test('cambiar un gasto a aporte limpia la categoría automáticamente', async () => {
    const { movimiento } = await gasto('Ocio', '50');
    const r = await app.movimientos.editar(movimiento.id, { tipo: 'ahorro_aporte', meta_id: iphone.id });
    assert.equal(r.movimiento.categoria_id, null);
    assert.equal(r.movimiento.meta, 'iPhone');
  });

  test('meta completada no admite aportes pero sí retiros (comprar el iPhone)', async () => {
    await aporte('200');
    await app.metas.cambiarEstado(iphone.id, 'completada');
    await rechaza(aporte('10'), BusinessRuleError, 'meta_inactiva');
    await retiro('200');
  });

  test('archivar con saldo → mensaje con el saldo', async () => {
    await aporte('50');
    await assert.rejects(app.metas.cambiarEstado(iphone.id, 'archivada'), /50,00/);
  });

  test('crear meta con saldo inicial mayor que el disponible → no se crea nada', async () => {
    await rechaza(app.metas.crear({ nombre: 'Viaje', objetivo: '2000', saldo_inicial: '600' }),
      BusinessRuleError, 'disponible_insuficiente');
    assert.equal(db.value("SELECT count(*) FROM metas_ahorro WHERE nombre = 'Viaje'"), 0);
  });

  test('crear meta con saldo inicial válido', async () => {
    const viaje = await app.metas.crear({ nombre: 'Viaje', objetivo: '2000', saldo_inicial: '300' });
    assert.equal(viaje.saldo_cent, 30000);
  });

  test('fecha límite pasada al crear → ValidationError', async () => {
    await rechaza(app.metas.crear({ nombre: 'Tarde', objetivo: '10', fecha_limite: '2026-11-21' }),
      ValidationError, 'fecha_pasada');
  });

  test('nombre duplicado ignorando mayúsculas con tilde', async () => {
    await app.metas.crear({ nombre: 'Ópera', objetivo: '100' });
    await rechaza(app.metas.crear({ nombre: 'ópera', objetivo: '100' }), ConflictError);
  });

  test('progreso y aporte necesario de noviembre', async () => {
    await aporte('300', '2026-10-15'); // antes del mes
    await aporte('50', '2026-11-05');
    const m = app.metas.obtener(iphone.id, { mes: '2026-11' });
    // falta al inicio de nov: 900 €; nov→mar = 5 meses → 180 €/mes; llevas 50 este mes
    assert.equal(m.necesario_mes_cent, 18000);
    assert.equal(m.pendiente_mes_cent, 13000);
    assert.equal(m.saldo_cent, 35000);
    assert.equal(m.estado_plan, 'en_curso');
  });
});

describe('listar con filtros', () => {
  beforeEach(async () => {
    await ingreso('1000', '2026-10-01');
    await gasto('Ocio', '10', '2026-10-15', { nota: 'descuento 50% cine' });
    await gasto('Supermercado', '40', '2026-11-02', { nota: 'compra semanal' });
    await gasto('Ocio', '25', '2026-11-12', { nota: 'concierto' });
  });

  test('por rango, tipo y categoría', () => {
    assert.equal(app.movimientos.listar({ desde: '2026-11-01', hasta: '2026-11-30' }).total, 2);
    assert.equal(app.movimientos.listar({ tipo: ['gasto'] }).total, 3);
    assert.equal(app.movimientos.listar({ tipo: 'ingreso' }).total, 1);
    assert.equal(app.movimientos.listar({ categoria_id: cat('Ocio') }).total, 2);
  });

  test('"hasta" incluye ese día y el orden es del más reciente', () => {
    const { items } = app.movimientos.listar({ hasta: '2026-11-12' });
    assert.equal(items[0].fecha, '2026-11-12');
  });

  test('búsqueda en notas: % y _ son literales', () => {
    assert.equal(app.movimientos.listar({ texto: '50%' }).total, 1);
    assert.equal(app.movimientos.listar({ texto: '%' }).total, 1);
    assert.equal(app.movimientos.listar({ texto: 'CONCIERTO' }).total, 1);
  });

  test('rango invertido y filtros inválidos', () => {
    assert.throws(() => app.movimientos.listar({ desde: '2026-11-30', hasta: '2026-11-01' }), ValidationError);
    assert.throws(() => app.movimientos.listar({ tipo: 'nada' }), ValidationError);
    assert.throws(() => app.movimientos.listar({ limite: 0 }), ValidationError);
  });

  test('paginación', () => {
    const p1 = app.movimientos.listar({ limite: 2 });
    const p2 = app.movimientos.listar({ limite: 2, offset: 2 });
    assert.equal(p1.items.length, 2);
    assert.equal(p2.items.length, 2);
    assert.equal(p1.total, 4);
  });
});

describe('catálogo', () => {
  test('categoría duplicada con tildes y mayúsculas', async () => {
    await app.categorias.crear({ nombre: 'Café', tipo: 'gasto' });
    await rechaza(app.categorias.crear({ nombre: '  CAFÉ ', tipo: 'gasto' }), ConflictError);
    await app.categorias.crear({ nombre: 'Café', tipo: 'ingreso' }); // otro tipo: permitido
  });

  test('borrar categoría usada → ConflictError (archívala)', async () => {
    await ingreso('10');
    await gasto('Ocio', '5');
    await rechaza(app.categorias.eliminar(cat('Ocio')), ConflictError, 'en_uso');
    await app.categorias.eliminar(cat('Salud')); // sin uso: se borra
  });

  test('no se puede archivar ni borrar la cuenta por defecto', async () => {
    const principal = app.cuentas.listar()[0];
    await rechaza(app.cuentas.activar(principal.id, false), BusinessRuleError, 'cuenta_por_defecto');
    const efectivo = await app.cuentas.crear({ nombre: 'Efectivo', tipo: 'efectivo', saldo_inicial: '40' });
    await app.ajustes.set('cuenta_por_defecto', efectivo.id);
    await app.cuentas.activar(principal.id, false);
  });

  test('saldo inicial negativo para una tarjeta y saldos por cuenta', async () => {
    const tarjeta = await app.cuentas.crear({ nombre: 'Visa', tipo: 'tarjeta', saldo_inicial: '-120,50' });
    assert.equal(tarjeta.saldo_inicial_cent, -12050);
    await ingreso('100');
    const porCuenta = Object.fromEntries(app.saldos.porCuenta().map((c) => [c.nombre, c.saldo_cent]));
    assert.deepEqual(porCuenta, { Principal: 10000, Visa: -12050 });
  });

  test('ajuste desconocido o inválido', async () => {
    await rechaza(app.ajustes.set('tema', 'oscuro'), ValidationError);
    await rechaza(app.ajustes.set('meses_historial', '0'), ValidationError);
    await rechaza(app.ajustes.set('cuenta_por_defecto', 999), NotFoundError);
  });
});

describe('presupuestos', () => {
  test('vigente = el más reciente anterior o igual al mes', async () => {
    const ocio = cat('Ocio');
    await app.presupuestos.definir({ categoria_id: ocio, desde_mes: '2026-09', limite: '150' });
    await app.presupuestos.definir({ categoria_id: ocio, desde_mes: '2026-11', limite: '100' });
    await app.presupuestos.definir({ categoria_id: ocio, desde_mes: '2027-02', limite: '' }); // sin límite
    assert.equal(app.presupuestos.vigente(ocio, '2026-08'), null);
    assert.equal(app.presupuestos.vigente(ocio, '2026-10').limite_cent, 15000);
    assert.equal(app.presupuestos.vigente(ocio, '2027-01').limite_cent, 10000);
    assert.equal(app.presupuestos.vigente(ocio, '2027-05').limite_cent, null);
  });

  test('definir dos veces el mismo mes sustituye, no duplica', async () => {
    await app.presupuestos.definir({ desde_mes: '2026-11', limite: '1000' });
    await app.presupuestos.definir({ desde_mes: '2026-11', limite: '900' });
    assert.equal(app.presupuestos.listar().length, 1);
    assert.equal(app.presupuestos.estadoMes('2026-11').general.limite_cent, 90000);
  });

  test('presupuesto sobre categoría de ingreso → ValidationError', async () => {
    await rechaza(app.presupuestos.definir({ categoria_id: cat('Nómina'), desde_mes: '2026-11', limite: '5' }), ValidationError);
  });

  test('niveles', () => {
    assert.equal(nivelPresupuesto(0, null, 80), 'sin_limite');
    assert.equal(nivelPresupuesto(7999, 10000, 80), 'ok');
    assert.equal(nivelPresupuesto(8000, 10000, 80), 'aviso');
    assert.equal(nivelPresupuesto(10000, 10000, 80), 'aviso');
    assert.equal(nivelPresupuesto(10001, 10000, 80), 'superado');
    assert.equal(nivelPresupuesto(0, 0, 80), 'ok');
    assert.equal(nivelPresupuesto(1, 0, 80), 'superado');
  });
});

describe('analítica', () => {
  test('mes sin ingresos: tasa de ahorro null, no división por cero', () => {
    const r = app.analitica.resumenMensual('2026-11');
    assert.equal(r.tasa_ahorro, null);
    assert.equal(r.ingresos_cent, 0);
  });

  test('resumen: los aportes no cuentan como gasto', async () => {
    await ingreso('1000');
    await gasto('Supermercado', '300');
    const meta = await app.metas.crear({ nombre: 'iPhone', objetivo: '1200' });
    await app.movimientos.crear({ tipo: 'ahorro_aporte', meta_id: meta.id, importe: '200', fecha: '2026-11-15' });
    const r = app.analitica.resumenMensual('2026-11');
    assert.equal(r.gastos_cent, 30000);
    assert.equal(r.ahorro_neto_cent, 70000);
    assert.equal(r.tasa_ahorro, 0.7);
    assert.equal(r.aportado_metas_cent, 20000);
  });

  test('desglose con comparación con el mes anterior', async () => {
    await ingreso('1000', '2026-10-01');
    await gasto('Ocio', '100', '2026-10-05');
    await gasto('Ocio', '60', '2026-11-05');
    await gasto('Supermercado', '240', '2026-11-06');
    const d = app.analitica.desgloseGastos('2026-11');
    assert.equal(d.total_cent, 30000);
    assert.deepEqual(d.categorias.map((c) => [c.nombre, c.gastado_cent, c.diferencia_cent]),
      [['Supermercado', 24000, 24000], ['Ocio', 6000, -4000]]);
    assert.equal(d.categorias[0].porcentaje, 0.8);
  });

  test('evolución rellena meses vacíos y cruza de año', async () => {
    await ingreso('1000', '2026-11-01');
    await gasto('Ocio', '50', '2027-01-03');
    const e = app.analitica.evolucion('2026-11', '2027-01');
    assert.deepEqual(e.map((x) => [x.mes, x.ingresos_cent, x.gastos_cent]),
      [['2026-11', 100000, 0], ['2026-12', 0, 0], ['2027-01', 0, 5000]]);
    assert.throws(() => app.analitica.evolucion('2027-01', '2026-11'), ValidationError);
  });
});
