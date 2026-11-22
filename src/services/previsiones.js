// Previsiones mensuales: gastos fijos (alquiler, suscripciones) e ingresos esperados.
// Las previsiones NO crean movimientos: sirven al plan para reservar dinero.
import { ValidationError } from '../errors.js';
import { parseImporte } from '../domain/money.js';
import {
  parseId, parseTexto, parseEnum, parseEntero, parseBool01, existe, fusionar,
} from './util.js';

export function makePrevisiones(ctx) {
  const { db } = ctx;

  function obtener(id) {
    return existe(
      db.get(`SELECT p.*, c.nombre AS categoria, c.icono FROM previsiones p
              JOIN categorias c ON c.id = p.categoria_id WHERE p.id = $id`,
      { $id: parseId(id, { field: 'id', label: 'la previsión' }) }),
      'La previsión no existe.',
    );
  }

  function validar(input) {
    const tipo = parseEnum(input.tipo, ['gasto', 'ingreso'], { field: 'tipo', label: 'el tipo' });
    const cat = ctx.catalogo.obtenerCategoria(input.categoria_id);
    if (cat.tipo !== tipo) {
      throw new ValidationError(`La categoría «${cat.nombre}» no es de ${tipo}.`, { code: 'categoria_tipo', field: 'categoria_id' });
    }
    return {
      $nombre: parseTexto(input.nombre, { field: 'nombre', label: 'el nombre', max: 60 }),
      $tipo: tipo,
      $cat: cat.id,
      $importe: parseImporte(input.importe, { field: 'importe' }),
      $dia: parseEntero(input.dia_mes, { field: 'dia_mes', label: 'el día del mes', min: 1, max: 31, optional: true }),
      $activa: parseBool01(input.activa, { defecto: 1 }),
    };
  }

  return {
    obtener,

    listar({ tipo, incluirInactivas = false } = {}) {
      const where = [];
      const params = {};
      if (tipo) { where.push('p.tipo = $tipo'); params.$tipo = tipo; }
      if (!incluirInactivas) where.push('p.activa = 1');
      return db.all(`SELECT p.*, c.nombre AS categoria, c.icono FROM previsiones p
                     JOIN categorias c ON c.id = p.categoria_id
                     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                     ORDER BY p.tipo, p.dia_mes IS NULL, p.dia_mes, p.nombre`, params);
    },

    /** Suma de previsiones activas por categoría: { [categoria_id]: céntimos }. */
    porCategoria(tipo) {
      const filas = db.all(`SELECT categoria_id, SUM(importe_cent) AS total FROM previsiones
                            WHERE activa = 1 AND tipo = $t GROUP BY categoria_id`, { $t: tipo });
      return Object.fromEntries(filas.map((f) => [f.categoria_id, f.total]));
    },

    async crear(input) {
      const p = validar(input);
      const id = await db.transaction((tx) => tx.run(`
        INSERT INTO previsiones (nombre, tipo, categoria_id, importe_cent, dia_mes, activa)
        VALUES ($nombre, $tipo, $cat, $importe, $dia, $activa)`, p).lastId);
      return obtener(id);
    },

    async editar(id, cambios) {
      const actual = obtener(id);
      const datos = fusionar({
        nombre: actual.nombre, tipo: actual.tipo, categoria_id: actual.categoria_id,
        importe: actual.importe_cent / 100, dia_mes: actual.dia_mes, activa: actual.activa,
      }, cambios, ['nombre', 'tipo', 'categoria_id', 'importe', 'dia_mes', 'activa']);
      const p = validar(datos);
      await db.transaction((tx) => tx.run(`UPDATE previsiones SET nombre = $nombre, tipo = $tipo, categoria_id = $cat,
        importe_cent = $importe, dia_mes = $dia, activa = $activa WHERE id = $id`, { ...p, $id: actual.id }));
      return obtener(actual.id);
    },

    async eliminar(id) {
      const actual = obtener(id);
      await db.transaction((tx) => tx.run('DELETE FROM previsiones WHERE id = $id', { $id: actual.id }));
    },
  };
}
