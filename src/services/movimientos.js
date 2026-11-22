// Movimientos: gastos, ingresos, aportes y retiros de metas.
//
// Reglas:
//  - Gasto/ingreso: categoría del mismo tipo y activa; cuenta activa (por defecto, la de ajustes).
//  - Aporte: meta activa y que quepa en tu dinero disponible (no puedes apartar lo que no tienes).
//  - Retiro: no más de lo que hay en la meta, y la meta no puede quedar en negativo en
//    NINGUNA fecha (un retiro con fecha anterior al aporte que lo cubre se rechaza).
//  - Un gasto que deja el disponible en negativo se PERMITE (ya ocurrió) pero genera aviso.
//  - Al editar, una categoría/cuenta/meta archivada se acepta si no ha cambiado.
import { BusinessRuleError, ValidationError } from '../errors.js';
import { parseImporte, assertCents, formatImporte } from '../domain/money.js';
import { parseFecha, mesDe, hoy, formatFecha } from '../domain/dates.js';
import {
  parseId, parseEnum, parseNota, parseEntero, existe, escaparLike,
} from './util.js';

export const TIPOS = ['gasto', 'ingreso', 'ahorro_aporte', 'ahorro_retiro'];
const esAhorro = (tipo) => tipo === 'ahorro_aporte' || tipo === 'ahorro_retiro';

const SELECT_MOV = `
  SELECT mv.*, c.nombre AS categoria, c.icono AS categoria_icono,
         ma.nombre AS meta, cu.nombre AS cuenta
  FROM movimientos mv
  LEFT JOIN categorias   c  ON c.id  = mv.categoria_id
  LEFT JOIN metas_ahorro ma ON ma.id = mv.meta_id
  LEFT JOIN cuentas      cu ON cu.id = mv.cuenta_id`;

export function makeMovimientos(ctx) {
  const { db } = ctx;

  function obtener(id) {
    return existe(
      db.get(`${SELECT_MOV} WHERE mv.id = $id`, { $id: parseId(id, { field: 'id', label: 'el movimiento' }) }),
      'El movimiento no existe.',
    );
  }

  function parseImporteEntrada(input) {
    if (input.importe_cent !== undefined) { // vía interna (importación): ya en céntimos
      assertCents(input.importe_cent);
      if (input.importe_cent <= 0) throw new ValidationError('El importe debe ser mayor que 0.', { field: 'importe' });
      return input.importe_cent;
    }
    return parseImporte(input.importe, { field: 'importe' });
  }

  /**
   * Normaliza y valida la entrada. `actual` = fila existente al editar.
   * Devuelve los parámetros listos para SQL.
   */
  function validar(input, actual, q) {
    const tipo = parseEnum(input.tipo, TIPOS, { field: 'tipo', label: 'el tipo de movimiento' });
    const fecha = parseFecha(input.fecha ?? hoy(ctx.now()), { field: 'fecha' });
    const importe = parseImporteEntrada(input);
    const nota = parseNota(input.nota);
    let categoriaId = null;
    let metaId = null;
    let cuentaId = parseId(input.cuenta_id, { field: 'cuenta_id', label: 'la cuenta', optional: true });

    if (!esAhorro(tipo)) {
      if (input.meta_id !== null && input.meta_id !== undefined && input.meta_id !== '') {
        throw new ValidationError('Un gasto o ingreso no va asociado a una meta.', { code: 'meta_no_aplica', field: 'meta_id' });
      }
      const cat = ctx.catalogo.obtenerCategoria(
        parseId(input.categoria_id, { field: 'categoria_id', label: 'la categoría' }), q,
      );
      if (cat.tipo !== tipo) {
        throw new ValidationError(`«${cat.nombre}» es una categoría de ${cat.tipo}, no de ${tipo}.`,
          { code: 'categoria_tipo', field: 'categoria_id' });
      }
      if (!cat.activa && cat.id !== actual?.categoria_id) {
        throw new BusinessRuleError(`La categoría «${cat.nombre}» está archivada.`, { code: 'categoria_inactiva', field: 'categoria_id' });
      }
      categoriaId = cat.id;
      cuentaId ??= Number(ctx.ajustes.get('cuenta_por_defecto')) || null;
      if (cuentaId === null) throw new ValidationError('Elige una cuenta.', { code: 'requerido', field: 'cuenta_id' });
    } else {
      if (input.categoria_id !== null && input.categoria_id !== undefined && input.categoria_id !== '') {
        throw new ValidationError('Los aportes y retiros van asociados a una meta, no a una categoría.',
          { code: 'categoria_no_aplica', field: 'categoria_id' });
      }
      const meta = ctx.metas.obtenerFila(parseId(input.meta_id, { field: 'meta_id', label: 'la meta' }), q);
      const mismaMeta = meta.id === actual?.meta_id && actual?.tipo === tipo;
      if (tipo === 'ahorro_aporte' && meta.estado !== 'activa' && !mismaMeta) {
        throw new BusinessRuleError(`La meta «${meta.nombre}» está ${meta.estado}: no admite aportes.`,
          { code: 'meta_inactiva', field: 'meta_id' });
      }
      metaId = meta.id;
    }

    if (cuentaId !== null) {
      const cuenta = ctx.catalogo.obtenerCuenta(cuentaId, q);
      if (!cuenta.activa && cuenta.id !== actual?.cuenta_id) {
        throw new BusinessRuleError(`La cuenta «${cuenta.nombre}» está archivada.`, { code: 'cuenta_inactiva', field: 'cuenta_id' });
      }
    }

    return { $fecha: fecha, $importe: importe, $tipo: tipo, $cat: categoriaId, $meta: metaId, $cuenta: cuentaId, $nota: nota };
  }

  /** Saldo de la meta sin contar el movimiento `excluirId` (para dar un mensaje claro antes de escribir). */
  function saldoMetaSin(metaId, excluirId, q) {
    return q.value(`SELECT COALESCE(SUM(CASE tipo WHEN 'ahorro_aporte' THEN importe_cent ELSE -importe_cent END), 0)
                    FROM movimientos WHERE meta_id = $m AND id IS NOT $ex`, { $m: metaId, $ex: excluirId });
  }

  /**
   * Comprueba que el saldo de la meta no es negativo en ninguna fecha.
   * Mismo día: los aportes cuentan antes que los retiros.
   */
  function verificarHistorialMeta(metaId, q) {
    const filas = q.all(`SELECT fecha, tipo, importe_cent FROM movimientos WHERE meta_id = $m
                         ORDER BY fecha, CASE tipo WHEN 'ahorro_aporte' THEN 0 ELSE 1 END, id`, { $m: metaId });
    let saldo = 0;
    for (const f of filas) {
      saldo += f.tipo === 'ahorro_aporte' ? f.importe_cent : -f.importe_cent;
      if (saldo < 0) {
        const nombre = q.value('SELECT nombre FROM metas_ahorro WHERE id = $m', { $m: metaId });
        throw new BusinessRuleError(
          `El ${formatFecha(f.fecha)} la meta «${nombre}» quedaría en ${formatImporte(saldo)}: `
          + 'en esa fecha aún no había dinero suficiente. Revisa la fecha del retiro.',
          { code: 'saldo_meta_historico', field: 'fecha' },
        );
      }
    }
  }

  /** Comprobaciones previas y posteriores a escribir, dentro de la transacción. */
  function reglasAntes(p, actual, q) {
    if (p.$tipo === 'ahorro_retiro') {
      const saldo = saldoMetaSin(p.$meta, actual?.id ?? null, q);
      if (p.$importe > saldo) {
        const nombre = q.value('SELECT nombre FROM metas_ahorro WHERE id = $m', { $m: p.$meta });
        throw new BusinessRuleError(
          saldo > 0
            ? `En «${nombre}» solo hay ${formatImporte(saldo)}. No puedes retirar ${formatImporte(p.$importe)}.`
            : `La meta «${nombre}» no tiene saldo.`,
          { code: 'saldo_meta_insuficiente', field: 'importe' },
        );
      }
    }
  }

  function reglasDespues(p, actual, q) {
    const metas = new Set([p.$meta, actual?.meta_id].filter(Boolean));
    for (const m of metas) verificarHistorialMeta(m, q);

    if (p.$tipo === 'ahorro_aporte') {
      const { disponible_cent: disp } = ctx.saldos.calcular(q);
      if (disp < 0) {
        const cabia = disp + p.$importe; // lo que habría disponible sin este aporte
        throw new BusinessRuleError(
          cabia > 0
            ? `Solo tienes ${formatImporte(cabia)} disponibles para apartar.`
            : 'No tienes dinero disponible para apartar. Registra antes tus ingresos o el saldo de tus cuentas.',
          { code: 'disponible_insuficiente', field: 'importe' },
        );
      }
    }
  }

  /** Avisos (no bloquean) tras guardar. */
  function avisos(p) {
    const lista = [];
    if (p.$fecha > hoy(ctx.now())) {
      lista.push({ tipo: 'fecha_futura', nivel: 'info', mensaje: `La fecha (${formatFecha(p.$fecha)}) es futura.` });
    }
    if (p.$tipo === 'gasto') {
      lista.push(...ctx.presupuestos.avisosTrasGasto(p.$cat, mesDe(p.$fecha)));
      const { disponible_cent: disp } = ctx.saldos.calcular();
      if (disp < 0) {
        lista.push({
          tipo: 'disponible_negativo',
          nivel: 'superado',
          mensaje: `Has gastado ${formatImporte(-disp)} más de lo que tenías libre: ese dinero sale de tus ahorros. `
            + 'Si es así, registra un retiro de la meta correspondiente.',
        });
      }
    }
    return lista;
  }

  function insertarEn(tx, input) {
    const p = validar(input, null, tx);
    reglasAntes(p, null, tx);
    const nuevo = tx.run(`INSERT INTO movimientos (fecha, importe_cent, tipo, categoria_id, meta_id, cuenta_id, nota)
                          VALUES ($fecha, $importe, $tipo, $cat, $meta, $cuenta, $nota)`, p).lastId;
    reglasDespues(p, null, tx);
    return nuevo;
  }

  const CAMPOS = ['fecha', 'importe', 'importe_cent', 'tipo', 'categoria_id', 'meta_id', 'cuenta_id', 'nota'];

  return {
    obtener,

    /**
     * Alta síncrona dentro de una transacción ya abierta, con todas las reglas.
     * La usa la importación de CSV para meter muchas filas de una vez (todo o nada).
     */
    insertarEn,

    async crear(input) {
      const id = await db.transaction((tx) => insertarEn(tx, input));
      const mov = obtener(id);
      return { movimiento: mov, avisos: avisos(paramsDe(mov)) };
    },

    /**
     * Edición parcial. Si cambias de familia (gasto ↔ aporte), los campos de la otra
     * familia se vacían solos salvo que los envíes explícitamente (y entonces es un error).
     */
    async editar(id, cambios) {
      const actual = obtener(id);
      const datos = { ...actual, importe_cent: actual.importe_cent };
      for (const k of CAMPOS) if (Object.hasOwn(cambios, k)) datos[k] = cambios[k];
      if (Object.hasOwn(cambios, 'importe')) delete datos.importe_cent;
      if (esAhorro(datos.tipo) && !Object.hasOwn(cambios, 'categoria_id')) datos.categoria_id = null;
      if (!esAhorro(datos.tipo) && !Object.hasOwn(cambios, 'meta_id')) datos.meta_id = null;

      await db.transaction((tx) => {
        const p = validar(datos, actual, tx);
        reglasAntes(p, actual, tx);
        tx.run(`UPDATE movimientos SET fecha = $fecha, importe_cent = $importe, tipo = $tipo, categoria_id = $cat,
                  meta_id = $meta, cuenta_id = $cuenta, nota = $nota,
                  actualizado_en = strftime('%Y-%m-%dT%H:%M:%S','now')
                WHERE id = $id`, { ...p, $id: actual.id });
        reglasDespues(p, actual, tx);
      });
      const mov = obtener(actual.id);
      return { movimiento: mov, avisos: avisos(paramsDe(mov)) };
    },

    async eliminar(id) {
      const actual = obtener(id);
      try {
        await db.transaction((tx) => {
          tx.run('DELETE FROM movimientos WHERE id = $id', { $id: actual.id });
          if (actual.meta_id) verificarHistorialMeta(actual.meta_id, tx);
        });
      } catch (err) {
        if (err.code === 'saldo_meta_negativo' || err.code === 'saldo_meta_historico') {
          throw new BusinessRuleError(
            `No puedes borrar este aporte: ese dinero ya se ha retirado de «${actual.meta}». Borra o reduce antes el retiro.`,
            { code: 'aporte_ya_retirado', cause: err },
          );
        }
        throw err;
      }
    },

    /**
     * Filtros: desde / hasta (fechas incluidas), tipo (uno o lista), categoria_id, meta_id,
     * cuenta_id, texto (busca en la nota), limite (1-500, por defecto 100), offset.
     */
    listar(filtros = {}) {
      const where = [];
      const params = {};
      if (filtros.desde) { where.push('mv.fecha >= $desde'); params.$desde = parseFecha(filtros.desde, { field: 'desde' }); }
      if (filtros.hasta) { where.push('mv.fecha <= $hasta'); params.$hasta = parseFecha(filtros.hasta, { field: 'hasta' }); }
      if (params.$desde && params.$hasta && params.$desde > params.$hasta) {
        throw new ValidationError('La fecha «desde» es posterior a «hasta».', { code: 'rango_fechas', field: 'desde' });
      }
      if (filtros.tipo) {
        const tipos = [filtros.tipo].flat().map((t) => parseEnum(t, TIPOS, { field: 'tipo', label: 'el tipo' }));
        where.push(`mv.tipo IN (${tipos.map((_, i) => `$t${i}`).join(', ')})`);
        tipos.forEach((t, i) => { params[`$t${i}`] = t; });
      }
      for (const campo of ['categoria_id', 'meta_id', 'cuenta_id']) {
        if (filtros[campo] !== undefined && filtros[campo] !== null && filtros[campo] !== '') {
          where.push(`mv.${campo} = $${campo}`);
          params[`$${campo}`] = parseId(filtros[campo], { field: campo });
        }
      }
      if (filtros.texto && String(filtros.texto).trim()) {
        where.push("mv.nota LIKE $texto ESCAPE '\\'");
        params.$texto = `%${escaparLike(String(filtros.texto).trim())}%`;
      }
      const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limite = parseEntero(filtros.limite, { field: 'limite', min: 1, max: 500, defecto: 100 });
      const offset = parseEntero(filtros.offset, { field: 'offset', min: 0, max: 1e9, defecto: 0 });
      const total = db.value(`SELECT count(*) FROM movimientos mv ${sqlWhere}`, params);
      const items = db.all(`${SELECT_MOV} ${sqlWhere} ORDER BY mv.fecha DESC, mv.id DESC
                            LIMIT ${limite} OFFSET ${offset}`, params);
      return { items, total };
    },
  };
}

function paramsDe(mov) {
  return { $fecha: mov.fecha, $tipo: mov.tipo, $cat: mov.categoria_id, $importe: mov.importe_cent };
}
