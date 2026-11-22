// Fechas como texto ISO 'YYYY-MM-DD' (día) y 'YYYY-MM' (mes).
// Todo el cálculo se hace con enteros año/mes/día: nada de Date con zonas horarias,
// que es la fuente nº 1 de bugs de "el gasto aparece el día anterior".
import { ValidationError } from '../errors.js';

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ES_DAY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;

export function diasEnMes(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // month 1-12; día 0 del siguiente = último de este
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function isoDay(y, m, d) {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

function checkParts(y, m, d, field) {
  if (y < 2000 || y > 2100) {
    throw new ValidationError('El año debe estar entre 2000 y 2100.', { code: 'fecha_rango', field });
  }
  if (m < 1 || m > 12 || d < 1 || d > diasEnMes(y, m)) {
    throw new ValidationError('Esa fecha no existe.', { code: 'fecha_inexistente', field });
  }
}

/**
 * Acepta 'YYYY-MM-DD' (lo que da <input type="date">) o 'dd/mm/aaaa'.
 * Devuelve siempre 'YYYY-MM-DD'. Rechaza fechas imposibles (30/02, mes 13…).
 */
export function parseFecha(input, { field = 'fecha' } = {}) {
  if (input === null || input === undefined || String(input).trim() === '') {
    throw new ValidationError('La fecha es obligatoria.', { code: 'fecha_vacia', field });
  }
  const s = String(input).trim();
  let y; let m; let d;
  let match = s.match(ISO_DAY);
  if (match) {
    [y, m, d] = match.slice(1).map(Number);
  } else if ((match = s.match(ES_DAY))) {
    [d, m, y] = match.slice(1).map(Number);
  } else {
    throw new ValidationError('Fecha no válida. Usa dd/mm/aaaa.', { code: 'fecha_formato', field });
  }
  checkParts(y, m, d, field);
  return isoDay(y, m, d);
}

/** Igual que parseFecha pero admite vacío → null (para campos opcionales como fecha límite). */
export function parseFechaOpcional(input, opts) {
  if (input === null || input === undefined || String(input).trim() === '') return null;
  return parseFecha(input, opts);
}

/** 'YYYY-MM' validado. */
export function parseMes(input, { field = 'mes' } = {}) {
  const match = String(input ?? '').trim().match(ISO_MONTH);
  if (!match) throw new ValidationError('Mes no válido (formato AAAA-MM).', { code: 'mes_formato', field });
  const [y, m] = match.slice(1).map(Number);
  checkParts(y, m, 1, field);
  return `${pad(y, 4)}-${pad(m)}`;
}

/**
 * Hoy en la zona horaria LOCAL del dispositivo.
 * Trampa: new Date().toISOString() da la fecha UTC → a las 00:30 en Madrid devolvería ayer.
 */
export function hoy(now = new Date()) {
  return isoDay(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function mesDe(fechaIso) {
  return fechaIso.slice(0, 7);
}

export function mesActual(now = new Date()) {
  return mesDe(hoy(now));
}

/** Suma n meses (n puede ser negativo) a 'YYYY-MM'. */
export function sumarMeses(mes, n) {
  const [y, m] = mes.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${pad(Math.floor(total / 12), 4)}-${pad((total % 12) + 1)}`;
}

/** Nº de meses de `desde` a `hasta` ('YYYY-MM'); positivo si hasta es posterior. */
export function mesesEntre(desde, hasta) {
  const [y1, m1] = desde.split('-').map(Number);
  const [y2, m2] = hasta.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

/**
 * Rango semiabierto [desde, hasta) de un mes, para consultas que usan el índice:
 *   WHERE fecha >= :desde AND fecha < :hasta
 */
export function rangoMes(mes) {
  const m = parseMes(mes);
  return { desde: `${m}-01`, hasta: `${sumarMeses(m, 1)}-01` };
}

/** Para previsiones con día 29-31: en meses más cortos se usa el último día. */
export function fechaEnMes(mes, dia) {
  const [y, m] = parseMes(mes).split('-').map(Number);
  return isoDay(y, m, Math.min(dia, diasEnMes(y, m)));
}

/** 'YYYY-MM-DD' → 'dd/mm/aaaa' para mostrar. */
export function formatFecha(fechaIso) {
  const [y, m, d] = fechaIso.split('-');
  return `${d}/${m}/${y}`;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** '2027-03' → 'marzo de 2027' */
export function formatMes(mes) {
  const [y, m] = mes.split('-').map(Number);
  return `${MESES[m - 1]} de ${y}`;
}
