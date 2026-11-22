import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseImporte, formatImporte, centsToInput, repartirProporcional } from '../src/domain/money.js';
import {
  parseFecha, parseFechaOpcional, parseMes, hoy, sumarMeses, mesesEntre, rangoMes, fechaEnMes, formatFecha,
} from '../src/domain/dates.js';
import { ValidationError } from '../src/errors.js';

describe('parseImporte', () => {
  const ok = {
    '12': 1200,
    '12,5': 1250,
    '12,50': 1250,
    '0,99': 99,
    ',50': 50,
    '1.234': 123400,       // punto como separador de miles
    '1.234,56': 123456,
    '1234.56': 123456,     // punto decimal (teclado en inglés)
    '1,234.56': 123456,
    '12.5': 1250,
    '1 234,56': 123456,
    '1 234,56 €': 123456,
    '  7 € ': 700,
    '0,10': 10,
    '+5': 500,
  };
  for (const [input, cents] of Object.entries(ok)) {
    test(`"${input}" → ${cents}`, () => assert.equal(parseImporte(input), cents));
  }

  test('0,1 + 0,2 en céntimos es exacto', () => {
    assert.equal(parseImporte('0,1') + parseImporte('0,2'), parseImporte('0,3'));
  });

  const bad = {
    '': 'importe_vacio',
    '   ': 'importe_vacio',
    '0': 'importe_cero',
    '0,00': 'importe_cero',
    '-5': 'importe_negativo',
    '12,345': 'importe_decimales',
    'abc': 'importe_formato',
    '1,2,3': 'importe_formato',
    '12..5': 'importe_formato',
    '1.23.4': 'importe_formato',
    '1e5': 'importe_formato',
    '2000000000': 'importe_maximo',
  };
  for (const [input, code] of Object.entries(bad)) {
    test(`"${input}" rechazado (${code})`, () => {
      assert.throws(() => parseImporte(input), (e) => e instanceof ValidationError && e.code === code);
    });
  }

  test('null / undefined rechazados', () => {
    assert.throws(() => parseImporte(null), ValidationError);
    assert.throws(() => parseImporte(undefined), ValidationError);
  });

  test('número (de un JSON) se interpreta en euros', () => {
    assert.equal(parseImporte(12.5), 1250);
    assert.equal(parseImporte(0.1 + 0.2), 30);
    assert.throws(() => parseImporte(NaN), ValidationError);
  });
});

describe('formato', () => {
  test('formatImporte en es-ES', () => {
    assert.equal(formatImporte(1250).replace(/\s/g, ' '), '12,50 €');
    assert.equal(formatImporte(12345678).replace(/\s/g, ' '), '123.456,78 €');
  });

  test('centsToInput', () => {
    assert.equal(centsToInput(123456), '1234,56');
    assert.equal(centsToInput(5), '0,05');
    assert.equal(centsToInput(-150), '-1,50');
  });

  test('formatImporte rechaza floats', () => {
    assert.throws(() => formatImporte(12.5), ValidationError);
  });
});

describe('repartirProporcional', () => {
  test('caso del ejemplo: 225 € entre ocio (200) y compras (150)', () => {
    const [ocio, compras] = repartirProporcional(22500, [20000, 15000]);
    assert.equal(ocio + compras, 22500);
    assert.deepEqual([ocio, compras], [12857, 9643]);
  });

  test('nunca pierde ni inventa céntimos', () => {
    const r = repartirProporcional(100, [1, 1, 1]);
    assert.equal(r.reduce((a, b) => a + b), 100);
    assert.deepEqual(r, [34, 33, 33]);
  });

  test('sin historial reparte a partes iguales', () => {
    assert.deepEqual(repartirProporcional(1000, [0, 0]), [500, 500]);
  });

  test('lista vacía', () => assert.deepEqual(repartirProporcional(1000, []), []));
});

describe('fechas', () => {
  test('ISO y dd/mm/aaaa', () => {
    assert.equal(parseFecha('2026-11-22'), '2026-11-22');
    assert.equal(parseFecha('22/11/2026'), '2026-11-22');
    assert.equal(parseFecha('1/3/2026'), '2026-03-01');
    assert.equal(parseFecha('01-03-2026'), '2026-03-01');
  });

  for (const bad of ['30/02/2026', '2026-02-29', '31/04/2026', '2026-13-01', '00/01/2026', 'ayer', '2026/11/22', '1/1/1999']) {
    test(`"${bad}" rechazada`, () => assert.throws(() => parseFecha(bad), ValidationError));
  }

  test('vacía obligatoria vs opcional', () => {
    assert.throws(() => parseFecha(''), (e) => e.code === 'fecha_vacia');
    assert.equal(parseFechaOpcional(''), null);
    assert.equal(parseFechaOpcional(null), null);
    assert.equal(parseFechaOpcional('15/03/2027'), '2027-03-15');
  });

  test('hoy() usa la fecha local, no UTC', () => {
    // 23 nov 00:30 hora local: toISOString() daría el día 22 en Madrid (UTC+1)
    const d = new Date(2026, 10, 23, 0, 30);
    assert.equal(hoy(d), '2026-11-23');
  });

  test('aritmética de meses', () => {
    assert.equal(sumarMeses('2026-11', 1), '2026-12');
    assert.equal(sumarMeses('2026-12', 1), '2027-01');
    assert.equal(sumarMeses('2027-01', -1), '2026-12');
    assert.equal(sumarMeses('2026-11', 16), '2028-03');
    assert.equal(mesesEntre('2026-11', '2027-03'), 4);
    assert.equal(mesesEntre('2027-03', '2026-11'), -4);
  });

  test('rangoMes es semiabierto y cruza de año', () => {
    assert.deepEqual(rangoMes('2026-12'), { desde: '2026-12-01', hasta: '2027-01-01' });
    assert.throws(() => rangoMes('2026-13'), ValidationError);
  });

  test('fechaEnMes recorta el día 31 en meses cortos', () => {
    assert.equal(fechaEnMes('2027-02', 31), '2027-02-28');
    assert.equal(fechaEnMes('2028-02', 31), '2028-02-29');
    assert.equal(fechaEnMes('2026-04', 31), '2026-04-30');
    assert.equal(fechaEnMes('2026-11', 15), '2026-11-15');
  });

  test('parseMes y formatFecha', () => {
    assert.equal(parseMes('2026-11'), '2026-11');
    assert.throws(() => parseMes('2026-00'), ValidationError);
    assert.equal(formatFecha('2026-03-01'), '01/03/2026');
  });
});
