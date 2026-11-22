import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp } from './helpers.js';
import { ValidationError } from '../src/errors.js';
import { leerCSV, aCSV } from '../src/domain/csv.js';

// Datos de ejemplo con todas las piezas: cuentas, categoría propia, meta con aportes y
// retiros, presupuesto, previsión, notas con caracteres conflictivos.
async function poblar({ app, cat }) {
  const tarjeta = await app.cuentas.crear({ nombre: 'Visa', tipo: 'tarjeta', saldo_inicial: '-50' });
  const cafe = await app.categorias.crear({ nombre: 'Café', tipo: 'gasto', icono: '☕' });
  await app.movimientos.crear({ tipo: 'ingreso', categoria_id: cat('Nómina'), importe: '1600', fecha: '2026-10-01' });
  await app.movimientos.crear({ tipo: 'gasto', categoria_id: cafe.id, importe: '1,80', fecha: '2026-10-02', nota: 'con "leche"; y punto' });
  await app.movimientos.crear({ tipo: 'gasto', categoria_id: cat('Ocio'), importe: '20', fecha: '2026-10-03', cuenta_id: tarjeta.id, nota: '=HIPERVINCULO("x")' });
  await app.movimientos.crear({ tipo: 'gasto', categoria_id: cat('Supermercado'), importe: '64,35', fecha: '2026-11-04', nota: 'línea 1\nlínea 2' });
  const meta = await app.metas.crear({ nombre: 'iPhone', objetivo: '1200', fecha_limite: '2027-03-31' });
  await app.movimientos.crear({ tipo: 'ahorro_aporte', meta_id: meta.id, importe: '300', fecha: '2026-10-05' });
  await app.movimientos.crear({ tipo: 'ahorro_retiro', meta_id: meta.id, importe: '50', fecha: '2026-10-20' });
  await app.presupuestos.definir({ categoria_id: cat('Ocio'), desde_mes: '2026-10', limite: '100' });
  await app.previsiones.crear({ nombre: 'Alquiler', tipo: 'gasto', categoria_id: cat('Vivienda'), importe: '650', dia_mes: 1 });
  await app.ajustes.set('estrategia_ingresos', 'media');
  return { meta, tarjeta, cafe };
}

const foto = (db) => Object.fromEntries(
  ['cuentas', 'categorias', 'metas_ahorro', 'movimientos', 'presupuestos', 'previsiones']
    .map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY id`)]),
);

describe('copia JSON', () => {
  test('ida y vuelta: otra instalación queda idéntica (datos, saldos y plan)', async () => {
    const a = await freshApp();
    await poblar(a);
    const { contenido, nombre } = await a.app.respaldo.exportarJSON();
    assert.equal(nombre, 'mis-cuentas-2026-11-22.json');

    const b = await freshApp();
    const r = await b.app.respaldo.restaurarJSON(contenido);
    assert.equal(r.movimientos, 6);
    assert.deepEqual(foto(b.db), foto(a.db));
    assert.deepEqual(b.app.saldos.calcular(), a.app.saldos.calcular());
    assert.deepEqual(b.app.plan.calcular('2026-11'), a.app.plan.calcular('2026-11'));
    assert.equal(b.app.ajustes.get('estrategia_ingresos'), 'media');
    assert.equal(b.app.ajustes.get('bienvenida'), 'hecha');
    assert.equal(b.app.ajustes.get('ultimo_respaldo'), '2026-11-22T12:00:00', 'la copia restaurada cuenta como último respaldo');
  });

  test('exportar anota la fecha del último respaldo', async () => {
    const { app } = await freshApp();
    assert.equal(app.ajustes.get('ultimo_respaldo'), null);
    await app.respaldo.exportarJSON();
    assert.equal(app.ajustes.get('ultimo_respaldo'), '2026-11-22T12:00:00');
  });

  test('restaurar reemplaza lo que hubiera (incluidas metas con retiros)', async () => {
    const origen = await freshApp();
    await origen.app.movimientos.crear({ tipo: 'ingreso', categoria_id: origen.cat('Nómina'), importe: '10', fecha: '2026-11-01' });
    const { contenido } = await origen.app.respaldo.exportarJSON();

    const destino = await freshApp();
    await poblar(destino); // tiene una meta con aporte y retiro: el borrado no debe fallar
    await destino.app.respaldo.restaurarJSON(contenido);
    assert.equal(destino.db.value('SELECT count(*) FROM movimientos'), 1);
    assert.equal(destino.db.value('SELECT count(*) FROM metas_ahorro'), 0);
  });

  const rechazos = {
    'no es JSON': ['{ roto', 'json_invalido'],
    'otra app': [JSON.stringify({ app: 'otra', datos: {} }), 'json_ajeno'],
    'formato desconocido': [JSON.stringify({ app: 'mis-cuentas', formato: 9, schema_version: 1, datos: {} }), 'json_formato'],
    'versión futura': [JSON.stringify({ app: 'mis-cuentas', formato: 1, schema_version: 99, datos: {} }), 'json_version_futura'],
    'tabla que no es lista': [JSON.stringify({ app: 'mis-cuentas', formato: 1, schema_version: 2, datos: { movimientos: 'x' } }), 'json_tabla'],
  };
  for (const [caso, [texto, code]] of Object.entries(rechazos)) {
    test(`rechaza: ${caso}`, async () => {
      const { app } = await freshApp();
      await assert.rejects(app.respaldo.restaurarJSON(texto), (e) => e instanceof ValidationError && e.code === code);
    });
  }

  test('una fila inválida → no se toca NADA de lo actual y se indica dónde', async () => {
    const a = await freshApp();
    await poblar(a);
    const copia = JSON.parse((await a.app.respaldo.exportarJSON()).contenido);
    copia.datos.movimientos[2].fecha = '2026-02-30';

    const b = await freshApp();
    await poblar(b);
    const antes = foto(b.db);
    await assert.rejects(b.app.respaldo.restaurarJSON(JSON.stringify(copia)),
      (e) => e.code === 'json_fila' && /movimientos», fila 3/.test(e.message));
    assert.deepEqual(foto(b.db), antes);
  });

  test('referencia rota (movimiento a una categoría que no existe) → rechazada', async () => {
    const a = await freshApp();
    await poblar(a);
    const copia = JSON.parse((await a.app.respaldo.exportarJSON()).contenido);
    copia.datos.movimientos[0].categoria_id = 999;
    const b = await freshApp();
    await assert.rejects(b.app.respaldo.restaurarJSON(JSON.stringify(copia)), ValidationError);
    assert.equal(b.db.value('SELECT count(*) FROM movimientos'), 0);
  });

  test('una copia con un retiro mayor que lo aportado se rechaza (lo vigilan los triggers)', async () => {
    const a = await freshApp();
    await poblar(a);
    const copia = JSON.parse((await a.app.respaldo.exportarJSON()).contenido);
    copia.datos.movimientos.find((m) => m.tipo === 'ahorro_retiro').importe_cent = 99999;
    const b = await freshApp();
    await assert.rejects(b.app.respaldo.restaurarJSON(JSON.stringify(copia)), ValidationError);
  });

  test('tolerante: columnas desconocidas se ignoran y las que faltan toman su valor por defecto', async () => {
    const a = await freshApp();
    await poblar(a);
    const copia = JSON.parse((await a.app.respaldo.exportarJSON()).contenido);
    for (const c of copia.datos.categorias) { delete c.icono; c.color_futuro = 'rojo'; }
    const b = await freshApp();
    await b.app.respaldo.restaurarJSON(JSON.stringify(copia));
    assert.equal(b.db.value("SELECT icono FROM categorias WHERE nombre = 'Café'"), null);
  });

  test('resumen previo para confirmar', async () => {
    const a = await freshApp();
    await poblar(a);
    const { contenido } = await a.app.respaldo.exportarJSON();
    const b = await freshApp();
    const r = b.app.respaldo.resumenJSON(contenido);
    assert.equal(r.movimientos, 6);
    assert.equal(r.metas, 1);
    assert.equal(r.actuales.movimientos, 0);
    assert.equal(r.exportado_en, '2026-11-22T12:00:00');
  });
});

describe('CSV: formato', () => {
  test('lee ; , y tabulador, comillas con saltos de línea y BOM', () => {
    const r = leerCSV('﻿fecha;importe;nota\r\n2026-11-01;12,50;"hola; ""amigo""\nadiós"\r\n\r\n');
    assert.equal(r.separador, ';');
    assert.deepEqual(r.filas, [['2026-11-01', '12,50', 'hola; "amigo"\nadiós']]);
    assert.equal(leerCSV('a,b\n1,2').separador, ',');
    assert.equal(leerCSV('a\tb\n1\t2').separador, '\t');
  });

  test('comillas sin cerrar o fichero vacío → error claro', () => {
    assert.throws(() => leerCSV('a;b\n"1;2'), (e) => e.code === 'csv_comillas');
    assert.throws(() => leerCSV('  \n \n'), (e) => e.code === 'csv_vacio');
  });

  test('escribir: BOM, punto y coma, comillas y protección contra fórmulas', () => {
    const out = aCSV([{ a: 'x;y', b: '=SUMA(1)', c: '-5' }], [
      { titulo: 'a', valor: (f) => f.a }, { titulo: 'b', valor: (f) => f.b }, { titulo: 'c', valor: (f) => f.c, seguro: true },
    ]);
    assert.equal(out, '﻿a;b;c\r\n"x;y";\'=SUMA(1);-5\r\n');
  });
});

describe('CSV: exportar e importar movimientos', () => {
  let a;
  beforeEach(async () => { a = await freshApp(); await poblar(a); });

  test('exporta en orden cronológico con importes «1,80»', () => {
    const { contenido, filas, nombre } = a.app.respaldo.exportarCSV();
    assert.equal(filas, 6);
    assert.equal(nombre, 'movimientos-2026-11-22.csv');
    const { cabecera, filas: f } = leerCSV(contenido);
    assert.deepEqual(cabecera, ['fecha', 'tipo', 'importe', 'categoria', 'meta', 'cuenta', 'nota']);
    assert.deepEqual(f[0].slice(0, 4), ['2026-10-01', 'ingreso', '1600,00', 'Nómina']);
    assert.equal(f[1][2], '1,80');
    assert.equal(f[2][6], '\'=HIPERVINCULO("x")');
  });

  test('ida y vuelta en otra instalación: mismos movimientos, nota con fórmula intacta', async () => {
    const { contenido } = a.app.respaldo.exportarCSV();
    const b = await freshApp();
    await b.app.cuentas.crear({ nombre: 'Visa', tipo: 'tarjeta' });
    await b.app.metas.crear({ nombre: 'iPhone', objetivo: '1200' });
    // Necesita saldo para el aporte: el ingreso del CSV va antes que el aporte.
    const r = await b.app.respaldo.importarCSV(contenido);
    assert.equal(r.importados, 6);
    assert.deepEqual(r.categorias_nuevas, ['Café (gasto)']);
    const notas = b.db.all('SELECT nota FROM movimientos ORDER BY fecha').map((x) => x.nota);
    assert.ok(notas.includes('=HIPERVINCULO("x")'));
    assert.ok(notas.includes('línea 1\nlínea 2'));
    assert.equal(b.app.metas.saldo(1), 25000);
  });

  test('reimportar el mismo CSV no duplica', async () => {
    const { contenido } = a.app.respaldo.exportarCSV();
    const r = await a.app.respaldo.importarCSV(contenido);
    assert.equal(r.importados, 0);
    assert.equal(r.duplicados, 6);
  });

  test('dos movimientos idénticos en el fichero y uno ya existente → se añade solo uno', async () => {
    // la nota contiene ; y comillas: en un CSV correcto va entre comillas
    const linea = '2026-10-02;gasto;1,80;Café;"con ""leche""; y punto"';
    const r = await a.app.respaldo.importarCSV(`fecha;tipo;importe;categoria;nota\n${linea}\n${linea}\n`);
    assert.equal(r.duplicados, 1);
    assert.equal(r.importados, 1);
  });

  test('vista previa (simular) no guarda nada', async () => {
    const antes = a.db.value('SELECT count(*) FROM movimientos');
    const savesAntes = a.storage.saves;
    const r = await a.app.respaldo.importarCSV('fecha;importe;categoria\n2026-11-10;-4,50;Panadería\n', { simular: true });
    assert.equal(r.simulado, true);
    assert.equal(r.importados, 1);
    assert.deepEqual(r.categorias_nuevas, ['Panadería (gasto)']);
    assert.equal(a.db.value('SELECT count(*) FROM movimientos'), antes);
    assert.equal(a.db.value("SELECT count(*) FROM categorias WHERE nombre = 'Panadería'"), 0);
    assert.equal(a.storage.saves, savesAntes);
  });

  test('extracto de banco: sin tipo ni categoría, importes con signo y cabeceras con tildes', async () => {
    const csv = 'Fecha Operación,Concepto,Importe\n05/11/2026,BIZUM JUAN,"25,00"\n06/11/2026,MERCADONA,"-1.234,56"\n';
    const r = await a.app.respaldo.importarCSV(csv);
    assert.equal(r.importados, 2);
    const filas = a.db.all(`SELECT m.tipo, m.importe_cent, c.nombre AS cat, m.nota FROM movimientos m
                            JOIN categorias c ON c.id = m.categoria_id WHERE m.fecha >= '2026-11-05' ORDER BY m.fecha`);
    assert.deepEqual(filas, [
      { tipo: 'ingreso', importe_cent: 2500, cat: 'Otros ingresos', nota: 'BIZUM JUAN' },
      { tipo: 'gasto', importe_cent: 123456, cat: 'Otros gastos', nota: 'MERCADONA' },
    ]);
  });

  test('categoría existente se reconoce sin distinguir mayúsculas ni tildes compuestas', async () => {
    const r = await a.app.respaldo.importarCSV('fecha;tipo;importe;categoria\n2026-11-10;gasto;3;  supermercado \n');
    assert.equal(r.categorias_nuevas.length, 0);
    assert.equal(r.importados, 1);
  });

  test('todo o nada: con una fila mala no entra ninguna y se listan las líneas', async () => {
    const antes = a.db.value('SELECT count(*) FROM movimientos');
    const csv = [
      'fecha;tipo;importe;categoria;meta',
      '2026-11-10;gasto;5;Nueva categoría;',
      '31/02/2026;gasto;5;Ocio;',
      '2026-11-11;regalo;5;Ocio;',
      '2026-11-12;aporte;5;;Viaje',
      '2026-11-13;gasto;0;Ocio;',
      '2026-11-14;retiro;9999;;iPhone',
    ].join('\n');
    await assert.rejects(a.app.respaldo.importarCSV(csv), (e) => {
      assert.equal(e.code, 'csv_filas');
      assert.deepEqual(e.detalles.map((d) => d.linea), [3, 4, 5, 6, 7]);
      assert.match(e.detalles[0].mensaje, /no existe/);
      assert.match(e.detalles[1].mensaje, /desconocido/);
      assert.match(e.detalles[2].mensaje, /Viaje/);
      assert.match(e.detalles[4].mensaje, /solo hay 250,00/);
      return true;
    });
    assert.equal(a.db.value('SELECT count(*) FROM movimientos'), antes);
    assert.equal(a.db.value("SELECT count(*) FROM categorias WHERE nombre = 'Nueva categoría'"), 0);
  });

  test('sin columnas obligatorias → dice cuáles tiene el fichero', async () => {
    await assert.rejects(a.app.respaldo.importarCSV('dia;euros_gastados\n1;2\n'),
      (e) => e.code === 'csv_columnas' && /dia, euros_gastados/.test(e.message));
  });

  test('con crearCategorias=false, una categoría desconocida es un error', async () => {
    await assert.rejects(a.app.respaldo.importarCSV('fecha;importe;categoria\n2026-11-10;-3;Inventada\n', { crearCategorias: false }),
      (e) => /Inventada/.test(e.detalles[0].mensaje));
  });
});

describe('recordatorio de copia', () => {
  test('sin datos no recuerda; con datos y sin copia en 3 días sí; tras exportar, no', async () => {
    const a = await freshApp();
    assert.equal(a.app.respaldo.estadoRespaldo().recordar, false);
    await a.app.movimientos.crear({ tipo: 'ingreso', categoria_id: a.cat('Nómina'), importe: '10', fecha: '2026-11-01' });
    await a.db.transaction((tx) => tx.run("UPDATE movimientos SET creado_en = '2026-11-10T09:00:00'"));
    assert.equal(a.app.respaldo.estadoRespaldo().recordar, true);
    await a.app.respaldo.exportarJSON();
    const e = a.app.respaldo.estadoRespaldo();
    assert.equal(e.recordar, false);
    assert.equal(e.dias, 0);
  });

  test('a los 7 días de la última copia vuelve a recordar', async () => {
    const a = await freshApp();
    await a.app.movimientos.crear({ tipo: 'ingreso', categoria_id: a.cat('Nómina'), importe: '10', fecha: '2026-11-01' });
    await a.app.ajustes.set('ultimo_respaldo', '2026-11-15T20:00:00');
    assert.deepEqual([a.app.respaldo.estadoRespaldo().dias, a.app.respaldo.estadoRespaldo().recordar], [7, true]);
    await a.app.ajustes.set('ultimo_respaldo', '2026-11-16T08:00:00');
    assert.equal(a.app.respaldo.estadoRespaldo().recordar, false);
  });
});
