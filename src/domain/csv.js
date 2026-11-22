// CSV sin dependencias, pensado para Excel en español y para extractos de banco.
//  - Escribe con «;» (Excel en español usa la coma como decimal) y BOM UTF-8 (para que
//    Excel no rompa las tildes).
//  - Lee «;», «,» o tabulador (lo detecta en la cabecera), comillas dobles con saltos de
//    línea dentro, comillas escapadas ("") y finales de línea Windows/Unix.
import { ValidationError } from '../errors.js';

const BOM = '﻿';

/**
 * Evita la «inyección de fórmulas»: Excel ejecuta celdas que empiezan por = + - @.
 * Una nota como "=HYPERLINK(...)" se exporta como texto anteponiendo un apóstrofo.
 */
function celdaSegura(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function citar(s, sep) {
  return /["\r\n]/.test(s) || s.includes(sep) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * columnas: [{ titulo, valor: (fila) => texto, seguro?: bool }]
 * `seguro: true` marca columnas generadas por la app (importes, fechas) que no necesitan
 * la protección de fórmulas (un importe nunca empieza por «=»).
 */
export function aCSV(filas, columnas, { sep = ';' } = {}) {
  const linea = (celdas) => celdas.map((c) => citar(c, sep)).join(sep);
  const out = [linea(columnas.map((c) => c.titulo))];
  for (const f of filas) {
    out.push(linea(columnas.map((c) => {
      const v = c.valor(f);
      return c.seguro ? String(v ?? '') : celdaSegura(v);
    })));
  }
  return BOM + out.join('\r\n') + '\r\n';
}

/** Devuelve { cabecera: string[], filas: string[][] (sin la cabecera), separador }. */
export function leerCSV(texto) {
  if (typeof texto !== 'string') throw new ValidationError('El fichero no es texto.', { code: 'csv_no_texto' });
  let t = texto.startsWith(BOM) ? texto.slice(1) : texto;
  t = t.replace(/\r\n?/g, '\n');
  if (!t.trim()) throw new ValidationError('El fichero está vacío.', { code: 'csv_vacio' });

  const primera = t.slice(0, t.indexOf('\n') === -1 ? t.length : t.indexOf('\n'));
  const cuenta = (c) => primera.split(c).length - 1;
  const sep = [';', '\t', ','].sort((a, b) => cuenta(b) - cuenta(a))[0];

  const registros = [];
  let fila = [];
  let celda = '';
  let entreComillas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (entreComillas) {
      if (c === '"' && t[i + 1] === '"') { celda += '"'; i++; } else if (c === '"') entreComillas = false;
      else celda += c;
    } else if (c === '"' && celda === '') entreComillas = true;
    else if (c === sep) { fila.push(celda); celda = ''; } else if (c === '\n') { fila.push(celda); registros.push(fila); fila = []; celda = ''; } else celda += c;
  }
  if (entreComillas) throw new ValidationError('El CSV tiene unas comillas sin cerrar.', { code: 'csv_comillas' });
  if (celda !== '' || fila.length) { fila.push(celda); registros.push(fila); }

  const noVacios = registros.filter((r) => r.some((c) => c.trim() !== ''));
  if (noVacios.length === 0) throw new ValidationError('El fichero está vacío.', { code: 'csv_vacio' });
  const [cabecera, ...filas] = noVacios;
  return { cabecera: cabecera.map((c) => c.trim()), filas, separador: sep };
}

/** Normaliza un título de columna: minúsculas, sin tildes ni espacios sobrantes. */
export function normalizarCabecera(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, '_');
}
