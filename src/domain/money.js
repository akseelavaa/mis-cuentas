// Dinero = enteros en céntimos. Nunca floats para cálculos.
import { ValidationError } from '../errors.js';

export const MAX_CENT = 100_000_000_000; // 1.000 millones de €: mismo tope que el CHECK del esquema

/**
 * Convierte lo que escribe el usuario a céntimos (entero > 0).
 *
 * Acepta: "12", "12,5", "12,50", "1.234,56", "1234.56", "1 234,56", "12 €".
 * Reglas para el separador:
 *  - Si hay "," y ".", el que aparece último es el decimal.
 *  - Solo ",": decimal.
 *  - Solo ".": si encaja con miles (1.234 / 12.345.678) son miles; si no, decimal.
 * Se parsea como texto (no con parseFloat) para no arrastrar errores binarios.
 */
export function parseImporte(input, { field = 'importe', allowZero = false } = {}) {
  if (input === null || input === undefined) {
    throw new ValidationError('El importe es obligatorio.', { code: 'importe_vacio', field });
  }
  if (typeof input === 'number') {
    // Por si llega un número (p. ej. de un JSON importado): se trata como euros.
    if (!Number.isFinite(input)) throw invalid(field);
    input = input.toFixed(2);
  }

  let s = String(input).trim().replace(/€/g, '').replace(/[\s  ]/g, '');
  if (s === '') throw new ValidationError('El importe es obligatorio.', { code: 'importe_vacio', field });
  if (s.startsWith('-')) {
    throw new ValidationError('El importe debe ser positivo; el tipo de movimiento ya indica si entra o sale.',
      { code: 'importe_negativo', field });
  }
  if (s.startsWith('+')) s = s.slice(1);

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let intPart;
  let decPart = '';

  if (lastComma !== -1 && lastDot !== -1) {
    const decSep = lastComma > lastDot ? ',' : '.';
    const thouSep = decSep === ',' ? '.' : ',';
    const [i, d, ...rest] = s.split(decSep);
    if (rest.length) throw invalid(field);
    if (!validThousands(i, thouSep)) throw invalid(field);
    intPart = i.split(thouSep).join('');
    decPart = d;
  } else if (lastComma !== -1) {
    const parts = s.split(',');
    if (parts.length !== 2) throw invalid(field);
    [intPart, decPart] = parts;
  } else if (lastDot !== -1) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
      intPart = s.replace(/\./g, '');
    } else {
      const parts = s.split('.');
      if (parts.length !== 2) throw invalid(field);
      [intPart, decPart] = parts;
    }
  } else {
    intPart = s;
  }

  if (intPart === '') intPart = '0'; // ",50" → 0,50
  if (!/^\d+$/.test(intPart) || !/^\d{0,2}$/.test(decPart)) {
    if (/^\d{3,}$/.test(decPart)) {
      throw new ValidationError('Usa como máximo 2 decimales.', { code: 'importe_decimales', field });
    }
    throw invalid(field);
  }

  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw invalid(field);
  if (cents === 0 && !allowZero) {
    throw new ValidationError('El importe debe ser mayor que 0.', { code: 'importe_cero', field });
  }
  if (cents > MAX_CENT) {
    throw new ValidationError('Importe demasiado grande.', { code: 'importe_maximo', field });
  }
  return cents;
}

function validThousands(intStr, sep) {
  if (!intStr.includes(sep)) return /^\d+$/.test(intStr);
  return new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(intStr);
}

function invalid(field) {
  return new ValidationError('Importe no válido. Ejemplos: 12,50 o 1.234,56', { code: 'importe_formato', field });
}

const fmt = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });

/** 123456 → "1234,56 €" (ojo: es-ES no agrupa miles en números de 4 cifras, es la norma RAE/CLDR). */
export function formatImporte(cents) {
  assertCents(cents);
  return fmt.format(cents / 100);
}

/** Céntimos → texto editable para un <input> ("1234,56"). */
export function centsToInput(cents) {
  assertCents(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

export function assertCents(value, field = 'importe') {
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError('Importe interno no válido (se esperaban céntimos enteros).', { code: 'importe_interno', field });
  }
}

/**
 * Reparte `total` céntimos proporcionalmente a `pesos` sin perder ni inventar céntimos
 * (método del resto mayor). Lo usará el plan mensual para proponer topes por categoría.
 */
export function repartirProporcional(total, pesos) {
  assertCents(total, 'total');
  if (pesos.length === 0) return [];
  const suma = pesos.reduce((a, b) => a + b, 0);
  if (suma <= 0) {
    // Sin historial: reparto a partes iguales.
    return repartirProporcional(total, pesos.map(() => 1));
  }
  const exactos = pesos.map((p) => (total * p) / suma);
  const base = exactos.map(Math.floor);
  let resto = total - base.reduce((a, b) => a + b, 0);
  const orden = exactos
    .map((x, i) => [x - Math.floor(x), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; resto > 0; k = (k + 1) % orden.length, resto--) base[orden[k][1]] += 1;
  return base;
}

/** Como parseImporte pero admite signo y cero (saldo inicial de una tarjeta en negativo, p. ej.). */
export function parseImporteConSigno(input, { field = 'importe' } = {}) {
  const s = typeof input === 'string' ? input.trim() : input;
  if (typeof s === 'string' && s.startsWith('-')) {
    return -parseImporte(s.slice(1), { field, allowZero: true });
  }
  if (typeof s === 'number' && s < 0) return -parseImporte(-s, { field, allowZero: true });
  return parseImporte(s, { field, allowZero: true });
}
