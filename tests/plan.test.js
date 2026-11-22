// El plan mensual con el ejemplo del iPhone.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp } from './helpers.js';
import { calcularAporteNecesario } from '../src/services/metas.js';
import { BusinessRuleError } from '../src/errors.js';

describe('calcularAporteNecesario (función pura)', () => {
  const meta = (extra) => ({ estado: 'activa', objetivo_cent: 120000, fecha_limite: null, aporte_mensual_cent: null, ...extra });
  const calc = (m, { inicio = 30000, actual = inicio, neto = 0, mes = '2026-11' } = {}) =>
    calcularAporteNecesario({ meta: m, mes, saldoInicioMes: inicio, saldoActual: actual, netoMes: neto });

  test('con fecha: reparte lo que falta entre los meses restantes (incluidos este y el último)', () => {
    const r = calc(meta({ fecha_limite: '2027-03-31' }));
    assert.equal(r.meses_restantes, 5);
    assert.equal(r.necesario_mes_cent, 18000);
  });

  test('redondea hacia arriba para no quedarse corto', () => {
    const r = calc(meta({ fecha_limite: '2027-01-15' }), { inicio: 0 }); // 1200 / 3
    assert.equal(r.necesario_mes_cent, 40000);
    const r2 = calc(meta({ objetivo_cent: 100000, fecha_limite: '2027-01-15' }), { inicio: 0 }); // 1000 / 3
    assert.equal(r2.necesario_mes_cent, 33334);
  });

  test('vencida: toca todo lo que falta', () => {
    const r = calc(meta({ fecha_limite: '2026-10-31' }));
    assert.equal(r.estado_plan, 'vencida');
    assert.equal(r.necesario_mes_cent, 90000);
  });

  test('alcanzada, cuota fija, sin fecha y no activa', () => {
    assert.equal(calc(meta({ fecha_limite: '2027-03-31' }), { actual: 120000 }).estado_plan, 'alcanzada');
    assert.equal(calc(meta({ aporte_mensual_cent: 5000 })).necesario_mes_cent, 5000);
    assert.equal(calc(meta({ aporte_mensual_cent: 5000 }), { inicio: 118000 }).necesario_mes_cent, 2000);
    assert.equal(calc(meta({})).estado_plan, 'sin_fecha');
    assert.equal(calc(meta({ estado: 'completada' })).necesario_mes_cent, 0);
  });

  test('lo ya aportado este mes reduce lo pendiente, pero no lo necesario', () => {
    const r = calc(meta({ fecha_limite: '2027-03-31' }), { neto: 5000, actual: 35000 });
    assert.equal(r.necesario_mes_cent, 18000);
    assert.equal(r.pendiente_mes_cent, 13000);
  });
});

describe('plan mensual: ejemplo del iPhone', () => {
  let app;
  let cat;
  let db;
  let iphone;

  // Ago–oct 2026. Ingresos variables: 1.800 / 1.600 / 1.900.
  // Gastos al mes: Vivienda 650 (fijo), Facturas 100, Supermercado 300, Transporte 100 → 1.150 necesarios
  //                Ocio 200, Ropa y compras 150 → 350 recortables.
  // iPhone: 1.200 € para marzo de 2027, con 300 € ya apartados.
  beforeEach(async () => {
    ({ app, cat, db } = await freshApp());
    const ingresos = { '2026-08': '1800', '2026-09': '1600', '2026-10': '1900' };
    const gastos = { Vivienda: '650', Facturas: '100', Supermercado: '300', Transporte: '100', Ocio: '200', 'Ropa y compras': '150' };
    for (const [mes, importe] of Object.entries(ingresos)) {
      await app.movimientos.crear({ tipo: 'ingreso', categoria_id: cat('Nómina'), importe, fecha: `${mes}-01` });
      for (const [c, imp] of Object.entries(gastos)) {
        await app.movimientos.crear({ tipo: 'gasto', categoria_id: cat(c), importe: imp, fecha: `${mes}-10` });
      }
    }
    await app.previsiones.crear({ nombre: 'Alquiler', tipo: 'gasto', categoria_id: cat('Vivienda'), importe: '650', dia_mes: 1 });
    iphone = await app.metas.crear({ nombre: 'iPhone', objetivo: '1200', fecha_limite: '2027-03-31' });
    await app.movimientos.crear({ tipo: 'ahorro_aporte', meta_id: iphone.id, importe: '300', fecha: '2026-09-15' });
  });

  test('ingreso estimado = mínimo de los 3 últimos meses', () => {
    const p = app.plan.calcular('2026-11');
    assert.equal(p.ingreso.estimado_cent, 160000);
    assert.equal(p.ingreso.fuente, 'historial');
    assert.equal(p.ingreso.meses_historial, 3);
  });

  test('topes: 270 € para caprichos repartidos 200:150 sin perder céntimos', () => {
    const p = app.plan.calcular('2026-11');
    // 1.600 − 180 (iPhone) − 1.150 (necesarios) = 270
    assert.equal(p.totales.aportes_metas_cent, 18000);
    assert.equal(p.totales.reservado_no_recortables_cent, 115000);
    assert.equal(p.totales.para_recortables_cent, 27000);
    const tope = (n) => p.categorias.find((c) => c.nombre === n).tope_cent;
    assert.equal(tope('Ocio'), 15429);
    assert.equal(tope('Ropa y compras'), 11571);
    assert.equal(tope('Vivienda'), 65000);
    assert.equal(p.viable, true);
  });

  test('a tu ritmo actual (ahorras 100 €/mes) llegarías en julio, no en marzo', () => {
    const p = app.plan.calcular('2026-11');
    const m = p.metas.find((x) => x.id === iphone.id);
    assert.equal(p.totales.capacidad_ahorro_habitual_cent, 10000);
    assert.equal(m.proyeccion_ritmo_actual, '2027-07');
    assert.equal(m.llega_a_tiempo, false);
    assert.ok(p.sugerencias.some((s) => s.tipo === 'meta_retrasada' && /julio de 2027/.test(s.mensaje)));
  });

  test('si ingresas más de lo previsto, sugiere apartar el excedente', async () => {
    await app.movimientos.crear({ tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '1700', fecha: '2026-11-01' });
    const p = app.plan.calcular('2026-11');
    assert.equal(p.ingreso.excedente_cent, 10000);
    assert.ok(p.sugerencias.some((s) => s.tipo === 'excedente' && /100,00/.test(s.mensaje) && /iPhone/.test(s.mensaje)));
  });

  test('ritmo diario: lo que queda para caprichos entre los días que faltan', async () => {
    await app.movimientos.crear({ tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '1700', fecha: '2026-11-01' });
    await app.movimientos.crear({ tipo: 'gasto', categoria_id: cat('Ocio'), importe: '120', fecha: '2026-11-08' });
    const p = app.plan.calcular('2026-11');
    assert.equal(p.ritmo.dias_restantes, 9); // del 22 al 30, ambos incluidos
    assert.equal(p.ritmo.restante_variable_cent, 3429 + 11571);
    assert.equal(p.ritmo.por_dia_cent, 1666);
  });

  test('estrategia "media" usa la media de ingresos', async () => {
    await app.ajustes.set('estrategia_ingresos', 'media');
    assert.equal(app.plan.calcular('2026-11').ingreso.estimado_cent, 176667);
  });

  test('si no llega: déficit y caprichos a 0', async () => {
    await app.metas.editar(iphone.id, { fecha_limite: '2026-12-31' }); // 900 € en 2 meses = 450/mes
    const p = app.plan.calcular('2026-11');
    // 1.600 − 450 − 1.150 = 0 → justo; con Netflix fijo no llega
    assert.equal(p.viable, true);
    await app.previsiones.crear({ nombre: 'Netflix', tipo: 'gasto', categoria_id: cat('Suscripciones'), importe: '13' });
    const p2 = app.plan.calcular('2026-11');
    assert.equal(p2.viable, false);
    assert.equal(p2.deficit_cent, 1300);
    assert.equal(p2.categorias.find((c) => c.nombre === 'Ocio').tope_cent, 0);
    assert.ok(p2.sugerencias.some((s) => s.tipo === 'deficit'));
  });

  test('aceptar el plan guarda los topes como presupuestos y respeta el umbral', async () => {
    await app.presupuestos.definir({ categoria_id: cat('Ocio'), desde_mes: '2026-10', limite: '500', umbral_aviso_pct: 90 });
    const estado = await app.plan.aceptar('2026-11');
    const ocio = estado.categorias.find((c) => c.nombre === 'Ocio');
    assert.equal(ocio.limite_cent, 15429);
    assert.equal(ocio.umbral_aviso_pct, 90);
    assert.equal(app.presupuestos.vigente(cat('Ocio'), '2026-10').limite_cent, 50000, 'octubre no cambia');
    // aceptar dos veces no duplica
    await app.plan.aceptar('2026-11');
    assert.equal(db.value("SELECT count(*) FROM presupuestos WHERE desde_mes = '2026-11'"), 5);
  });
});

describe('plan mensual: poco o ningún historial', () => {
  let app;
  let cat;
  beforeEach(async () => { ({ app, cat } = await freshApp()); });

  test('sin datos → pide una estimación; aceptar falla', async () => {
    const p = app.plan.calcular('2026-11');
    assert.equal(p.necesita_estimacion, true);
    await assert.rejects(app.plan.aceptar('2026-11'), BusinessRuleError);
  });

  test('con previsión de ingresos y sin historial → reparte a partes iguales', async () => {
    await app.previsiones.crear({ nombre: 'Sueldo aprox.', tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '1000' });
    await app.previsiones.crear({ nombre: 'Alquiler', tipo: 'gasto', categoria_id: cat('Vivienda'), importe: '500' });
    const p = app.plan.calcular('2026-11');
    assert.equal(p.ingreso.fuente, 'previsiones');
    const recortables = p.categorias.filter((c) => c.recortable);
    assert.equal(recortables.reduce((a, c) => a + c.tope_cent, 0), 50000);
    assert.equal(recortables[0].tope_cent, 10000); // 500 € entre 5 categorías
  });

  test('sin historial: avisa de que es orientativo y no proyecta fechas', async () => {
    await app.previsiones.crear({ nombre: 'Sueldo', tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '1600' });
    await app.movimientos.crear({ tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '1600', fecha: '2026-11-01' });
    const meta = await app.metas.crear({ nombre: 'iPhone', objetivo: '1200', fecha_limite: '2027-03-31' });
    const p = app.plan.calcular('2026-11');
    assert.ok(p.sugerencias.some((s) => s.tipo === 'poco_historial' && /gastos fijos/.test(s.mensaje)));
    const m = p.metas.find((x) => x.id === meta.id);
    assert.equal(m.proyeccion_disponible, false);
    assert.equal(m.llega_a_tiempo, null);
  });

  test('lo ya gastado este mes en lo necesario se reserva aunque no haya historial', async () => {
    await app.previsiones.crear({ nombre: 'Sueldo', tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '1000' });
    await app.movimientos.crear({ tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '1000', fecha: '2026-11-01' });
    await app.movimientos.crear({ tipo: 'gasto', categoria_id: cat('Supermercado'), importe: '300', fecha: '2026-11-05' });
    const p = app.plan.calcular('2026-11');
    assert.equal(p.totales.reservado_no_recortables_cent, 30000);
    assert.equal(p.totales.para_recortables_cent, 70000);
  });

  test('el primer mes a medias no cuenta como historial', async () => {
    await app.movimientos.crear({ tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '300', fecha: '2026-10-20' });
    assert.equal(app.plan.calcular('2026-11').ingreso.meses_historial, 0);
  });

  test('empezar el día 1-3 sí cuenta; con 1 mes es historial parcial', async () => {
    await app.movimientos.crear({ tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '1500', fecha: '2026-10-02' });
    const p = app.plan.calcular('2026-11');
    assert.equal(p.ingreso.meses_historial, 1);
    assert.equal(p.ingreso.fuente, 'historial_parcial');
    assert.equal(p.ingreso.estimado_cent, 150000);
  });

  test('un mes intermedio sin ingresos cuenta como 0 (estimación prudente)', async () => {
    await app.movimientos.crear({ tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '1500', fecha: '2026-08-01' });
    await app.movimientos.crear({ tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '1500', fecha: '2026-10-01' });
    const p = app.plan.calcular('2026-11');
    assert.equal(p.ingreso.estimado_cent, 0);
    assert.equal(p.viable, true); // sin metas ni gastos: 0 − 0 = 0
  });
});
