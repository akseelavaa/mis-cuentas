// Validadores compartidos por los servicios. Todos lanzan ValidationError con `field`
// para que la UI pueda marcar el campo del formulario.
import { ValidationError, NotFoundError } from '../errors.js';

const vacio = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

export function parseId(v, { field, label = field, optional = false } = {}) {
  if (vacio(v)) {
    if (optional) return null;
    throw new ValidationError(`Falta ${label}.`, { code: 'requerido', field });
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ValidationError(`${capital(label)} no válido.`, { code: 'id_invalido', field });
  }
  return n;
}

/** Texto: recorta, colapsa espacios, normaliza Unicode (NFC). Vacío → null si es opcional. */
export function parseTexto(v, { field, label = field, max, optional = false } = {}) {
  if (vacio(v)) {
    if (optional) return null;
    throw new ValidationError(`${capital(label)} es obligatorio.`, { code: 'requerido', field });
  }
  const s = normalizar(String(v));
  if (max && s.length > max) {
    throw new ValidationError(`${capital(label)}: máximo ${max} caracteres.`, { code: 'demasiado_largo', field });
  }
  return s;
}

/** Nota libre: conserva saltos de línea, solo recorta extremos. */
export function parseNota(v, { max = 500 } = {}) {
  if (vacio(v)) return null;
  const s = String(v).normalize('NFC').trim();
  if (s.length > max) {
    throw new ValidationError(`La nota admite como máximo ${max} caracteres.`, { code: 'demasiado_largo', field: 'nota' });
  }
  return s;
}

export function parseEnum(v, valores, { field, label = field } = {}) {
  if (!valores.includes(v)) {
    throw new ValidationError(`${capital(label)} no válido.`, { code: 'valor_invalido', field });
  }
  return v;
}

export function parseEntero(v, { field, label = field, min, max, optional = false, defecto } = {}) {
  if (vacio(v)) {
    if (defecto !== undefined) return defecto;
    if (optional) return null;
    throw new ValidationError(`${capital(label)} es obligatorio.`, { code: 'requerido', field });
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ValidationError(`${capital(label)} debe ser un número entre ${min} y ${max}.`, { code: 'rango', field });
  }
  return n;
}

export function parseBool01(v, { defecto = 1 } = {}) {
  if (v === undefined || v === null || v === '') return defecto;
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0;
}

export function normalizar(s) {
  return s.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** Clave para comparar nombres: ignora mayúsculas también en letras acentuadas (Ócio = ócio). */
export function clave(s) {
  return normalizar(s).toLocaleLowerCase('es');
}

export function capital(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Lanza NotFoundError si la fila es null. */
export function existe(row, mensaje, field) {
  if (!row) throw new NotFoundError(mensaje, { code: 'no_existe', field });
  return row;
}

/** Copia solo las claves presentes en `cambios` sobre `base` (edición parcial). */
export function fusionar(base, cambios, claves) {
  const out = { ...base };
  for (const k of claves) if (Object.hasOwn(cambios, k)) out[k] = cambios[k];
  return out;
}

/** Escapa % y _ para LIKE ... ESCAPE '\'. */
export function escaparLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
