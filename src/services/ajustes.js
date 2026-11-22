// Ajustes clave/valor con validación por clave (lista blanca).
import { ValidationError, BusinessRuleError } from '../errors.js';
import { parseEnum, parseEntero, parseId } from './util.js';

export function makeAjustes(ctx) {
  const { db } = ctx;

  const VALIDADORES = {
    cuenta_por_defecto(v) {
      const id = parseId(v, { field: 'cuenta_por_defecto', label: 'la cuenta' });
      const cuenta = ctx.catalogo.obtenerCuenta(id);
      if (!cuenta.activa) throw new BusinessRuleError('La cuenta está archivada.', { code: 'cuenta_inactiva' });
      return String(id);
    },
    estrategia_ingresos: (v) => parseEnum(v, ['minimo', 'media'], { field: 'estrategia_ingresos', label: 'la estrategia' }),
    meses_historial: (v) => String(parseEntero(v, { field: 'meses_historial', label: 'los meses de historial', min: 1, max: 12 })),
    bienvenida: (v) => parseEnum(v, ['hecha'], { field: 'bienvenida' }),
    ultimo_respaldo: (v) => {
      if (v !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(v))) {
        throw new ValidationError('Fecha de respaldo no válida.', { field: 'ultimo_respaldo' });
      }
      return v;
    },
  };

  return {
    get(clave) {
      return db.value('SELECT valor FROM ajustes WHERE clave = $c', { $c: clave });
    },
    getNumero(clave, defecto) {
      const v = Number(this.get(clave));
      return Number.isFinite(v) && v > 0 ? v : defecto;
    },
    todos() {
      return Object.fromEntries(db.all('SELECT clave, valor FROM ajustes').map((r) => [r.clave, r.valor]));
    },
    async set(clave, valor) {
      const validar = VALIDADORES[clave];
      if (!validar) throw new ValidationError(`Ajuste desconocido: ${clave}.`, { code: 'ajuste_desconocido' });
      const v = validar(valor);
      await db.transaction((tx) => tx.run(
        'INSERT INTO ajustes (clave, valor) VALUES ($c, $v) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor',
        { $c: clave, $v: v },
      ));
    },
  };
}
