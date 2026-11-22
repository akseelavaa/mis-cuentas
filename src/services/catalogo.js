// Cuentas y categorías.
import { ConflictError, BusinessRuleError } from '../errors.js';
import { parseImporteConSigno } from '../domain/money.js';
import {
  parseId, parseTexto, parseEnum, parseBool01, clave, existe, fusionar,
} from './util.js';

const TIPOS_CUENTA = ['efectivo', 'banco', 'tarjeta', 'otro'];
const TIPOS_CATEGORIA = ['gasto', 'ingreso'];

export function makeCatalogo(ctx) {
  const { db } = ctx;

  // ------------------------------------------------------------------ cuentas

  function obtenerCuenta(id, q = db) {
    return existe(
      q.get('SELECT * FROM cuentas WHERE id = $id', { $id: parseId(id, { field: 'cuenta_id', label: 'la cuenta' }) }),
      'La cuenta no existe.', 'cuenta_id',
    );
  }

  function validarCuenta(input, idActual = null) {
    const nombre = parseTexto(input.nombre, { field: 'nombre', label: 'el nombre', max: 60 });
    nombreUnico('cuentas', nombre, idActual, 'Ya existe una cuenta con ese nombre.');
    return {
      $nombre: nombre,
      $tipo: parseEnum(input.tipo ?? 'banco', TIPOS_CUENTA, { field: 'tipo', label: 'el tipo de cuenta' }),
      $saldo: input.saldo_inicial === undefined || input.saldo_inicial === ''
        ? 0 : parseImporteConSigno(input.saldo_inicial, { field: 'saldo_inicial' }),
    };
  }

  function nombreUnico(tabla, nombre, idActual, mensaje, extraWhere = '', extraParams = {}) {
    const filas = db.all(`SELECT id, nombre FROM ${tabla} WHERE 1=1 ${extraWhere}`, extraParams);
    if (filas.some((f) => f.id !== idActual && clave(f.nombre) === clave(nombre))) {
      throw new ConflictError(mensaje, { code: 'duplicado', field: 'nombre' });
    }
  }

  const cuentas = {
    listar({ incluirInactivas = false } = {}) {
      return db.all(`SELECT * FROM cuentas ${incluirInactivas ? '' : 'WHERE activa = 1'} ORDER BY nombre`);
    },
    obtener: (id) => obtenerCuenta(id),

    async crear(input) {
      const p = validarCuenta(input);
      const id = await db.transaction((tx) => tx.run(
        'INSERT INTO cuentas (nombre, tipo, saldo_inicial_cent) VALUES ($nombre, $tipo, $saldo)', p,
      ).lastId);
      return obtenerCuenta(id);
    },

    async editar(id, cambios) {
      const actual = obtenerCuenta(id);
      const datos = fusionar(
        { nombre: actual.nombre, tipo: actual.tipo, saldo_inicial: actual.saldo_inicial_cent / 100 },
        cambios, ['nombre', 'tipo', 'saldo_inicial'],
      );
      const p = validarCuenta(datos, actual.id);
      await db.transaction((tx) => tx.run(
        'UPDATE cuentas SET nombre = $nombre, tipo = $tipo, saldo_inicial_cent = $saldo WHERE id = $id',
        { ...p, $id: actual.id },
      ));
      return obtenerCuenta(actual.id);
    },

    async activar(id, activa) {
      const actual = obtenerCuenta(id);
      if (!activa && Number(ctx.ajustes.get('cuenta_por_defecto')) === actual.id) {
        throw new BusinessRuleError('Es tu cuenta por defecto. Elige otra por defecto antes de archivarla.',
          { code: 'cuenta_por_defecto' });
      }
      await db.transaction((tx) => tx.run('UPDATE cuentas SET activa = $a WHERE id = $id',
        { $a: activa ? 1 : 0, $id: actual.id }));
      return obtenerCuenta(actual.id);
    },

    async eliminar(id) {
      const actual = obtenerCuenta(id);
      if (db.value('SELECT 1 FROM movimientos WHERE cuenta_id = $id LIMIT 1', { $id: actual.id })) {
        throw new ConflictError('La cuenta tiene movimientos. Archívala en lugar de borrarla.', { code: 'en_uso' });
      }
      if (Number(ctx.ajustes.get('cuenta_por_defecto')) === actual.id) {
        throw new BusinessRuleError('No puedes borrar tu cuenta por defecto.', { code: 'cuenta_por_defecto' });
      }
      await db.transaction((tx) => tx.run('DELETE FROM cuentas WHERE id = $id', { $id: actual.id }));
    },
  };

  // --------------------------------------------------------------- categorías

  function obtenerCategoria(id, q = db) {
    return existe(
      q.get('SELECT * FROM categorias WHERE id = $id',
        { $id: parseId(id, { field: 'categoria_id', label: 'la categoría' }) }),
      'La categoría no existe.', 'categoria_id',
    );
  }

  function validarCategoria(input, tipo, idActual = null) {
    const nombre = parseTexto(input.nombre, { field: 'nombre', label: 'el nombre', max: 60 });
    nombreUnico('categorias', nombre, idActual, `Ya existe una categoría de ${tipo} con ese nombre.`,
      'AND tipo = $tipo', { $tipo: tipo });
    const icono = parseTexto(input.icono, { field: 'icono', label: 'el icono', max: 8, optional: true });
    return {
      $nombre: nombre,
      $icono: icono,
      $recortable: parseBool01(input.recortable, { defecto: tipo === 'gasto' ? 1 : 0 }),
    };
  }

  const categorias = {
    listar({ tipo, incluirInactivas = false } = {}) {
      const where = [];
      const params = {};
      if (tipo) { where.push('tipo = $tipo'); params.$tipo = parseEnum(tipo, TIPOS_CATEGORIA, { field: 'tipo' }); }
      if (!incluirInactivas) where.push('activa = 1');
      return db.all(`SELECT * FROM categorias ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                     ORDER BY tipo, nombre`, params);
    },
    obtener: (id) => obtenerCategoria(id),

    async crear(input) {
      const tipo = parseEnum(input.tipo, TIPOS_CATEGORIA, { field: 'tipo', label: 'el tipo de categoría' });
      const p = validarCategoria(input, tipo);
      const id = await db.transaction((tx) => tx.run(
        `INSERT INTO categorias (nombre, tipo, icono, recortable)
         VALUES ($nombre, $tipo, $icono, $recortable)`, { ...p, $tipo: tipo },
      ).lastId);
      return obtenerCategoria(id);
    },

    /** El tipo (gasto/ingreso) no se edita: si te equivocaste, crea otra y archiva esta. */
    async editar(id, cambios) {
      const actual = obtenerCategoria(id);
      const datos = fusionar(actual, cambios, ['nombre', 'icono', 'recortable']);
      const p = validarCategoria(datos, actual.tipo, actual.id);
      await db.transaction((tx) => tx.run(
        'UPDATE categorias SET nombre = $nombre, icono = $icono, recortable = $recortable WHERE id = $id',
        { ...p, $id: actual.id },
      ));
      return obtenerCategoria(actual.id);
    },

    async activar(id, activa) {
      const actual = obtenerCategoria(id);
      await db.transaction((tx) => tx.run('UPDATE categorias SET activa = $a WHERE id = $id',
        { $a: activa ? 1 : 0, $id: actual.id }));
      return obtenerCategoria(actual.id);
    },

    async eliminar(id) {
      const actual = obtenerCategoria(id);
      const usos = db.get(`SELECT
          (SELECT count(*) FROM movimientos WHERE categoria_id = $id) AS movs,
          (SELECT count(*) FROM previsiones WHERE categoria_id = $id) AS prevs`, { $id: actual.id });
      if (usos.movs || usos.prevs) {
        throw new ConflictError(
          `La categoría se usa en ${usos.movs} movimiento(s) y ${usos.prevs} gasto(s) fijo(s). Archívala en lugar de borrarla.`,
          { code: 'en_uso' },
        );
      }
      await db.transaction((tx) => tx.run('DELETE FROM categorias WHERE id = $id', { $id: actual.id }));
    },
  };

  return { cuentas, categorias, obtenerCuenta, obtenerCategoria };
}
