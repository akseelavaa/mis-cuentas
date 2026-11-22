// Presupuestos mensuales: vigentes desde un mes hasta que otro los sustituya.
import { ValidationError } from '../errors.js';
import { parseImporte, formatImporte } from '../domain/money.js';
import { parseMes, rangoMes } from '../domain/dates.js';
import { parseId, parseEntero, existe } from './util.js';

/** ok | aviso | superado | sin_limite. Aritmética entera: nada de floats en comparaciones. */
export function nivelPresupuesto(gastado, limite, umbralPct) {
  if (limite === null || limite === undefined) return 'sin_limite';
  if (limite === 0) return gastado > 0 ? 'superado' : 'ok';
  if (gastado > limite) return 'superado';
  if (gastado * 100 >= limite * umbralPct) return 'aviso';
  return 'ok';
}

export function makePresupuestos(ctx) {
  const { db } = ctx;

  /** Fila vigente para (categoría | null = general) en `mes`, o null si nunca se definió. */
  function vigente(categoriaId, mes, q = db) {
    return q.get(`SELECT * FROM presupuestos
                  WHERE categoria_id IS $cat AND desde_mes <= $mes
                  ORDER BY desde_mes DESC LIMIT 1`, { $cat: categoriaId, $mes: mes });
  }

  function estado(gastado, fila) {
    const limite = fila?.limite_cent ?? null;
    const umbral = fila?.umbral_aviso_pct ?? 80;
    return {
      gastado_cent: gastado,
      limite_cent: limite,
      umbral_aviso_pct: umbral,
      restante_cent: limite === null ? null : limite - gastado,
      uso: limite ? gastado / limite : null, // ratio para la barra de progreso
      nivel: nivelPresupuesto(gastado, limite, umbral),
    };
  }

  function estadoMes(mes) {
    const m = parseMes(mes);
    const { desde, hasta } = rangoMes(m);
    const filas = db.all(`
      SELECT c.id AS categoria_id, c.nombre, c.icono, c.recortable, c.activa,
             COALESCE(SUM(mv.importe_cent), 0) AS gastado
      FROM categorias c
      LEFT JOIN movimientos mv ON mv.categoria_id = c.id AND mv.fecha >= $desde AND mv.fecha < $hasta
      WHERE c.tipo = 'gasto'
      GROUP BY c.id
      HAVING c.activa = 1 OR gastado > 0
      ORDER BY gastado DESC, c.nombre`, { $desde: desde, $hasta: hasta });

    const categorias = filas.map((f) => ({
      categoria_id: f.categoria_id, nombre: f.nombre, icono: f.icono, recortable: f.recortable,
      ...estado(f.gastado, vigente(f.categoria_id, m)),
    }));
    const total = filas.reduce((a, f) => a + f.gastado, 0);
    return { mes: m, general: estado(total, vigente(null, m)), categorias };
  }

  /** Avisos para mostrar tras registrar un gasto en `categoriaId` el `mes`. */
  function avisosTrasGasto(categoriaId, mes) {
    const e = estadoMes(mes);
    const avisos = [];
    const cat = e.categorias.find((c) => c.categoria_id === categoriaId);
    for (const [obj, nombre] of [[cat, cat?.nombre], [e.general, 'tu límite general']]) {
      if (!obj || (obj.nivel !== 'aviso' && obj.nivel !== 'superado')) continue;
      avisos.push({
        tipo: 'presupuesto',
        nivel: obj.nivel,
        categoria_id: obj === e.general ? null : categoriaId,
        mensaje: obj.nivel === 'superado'
          ? `Has superado ${obj === e.general ? nombre : `el presupuesto de ${nombre}`}: `
            + `${formatImporte(obj.gastado_cent)} de ${formatImporte(obj.limite_cent)}.`
          : `Vas por ${formatImporte(obj.gastado_cent)} de ${formatImporte(obj.limite_cent)} `
            + `en ${nombre}. Te quedan ${formatImporte(obj.restante_cent)}.`,
      });
    }
    return avisos;
  }

  function validar(input) {
    const categoriaId = parseId(input.categoria_id, { field: 'categoria_id', label: 'la categoría', optional: true });
    if (categoriaId !== null) {
      const cat = ctx.catalogo.obtenerCategoria(categoriaId);
      if (cat.tipo !== 'gasto') {
        throw new ValidationError('Los presupuestos solo se asignan a categorías de gasto.',
          { code: 'categoria_no_gasto', field: 'categoria_id' });
      }
    }
    const sinLimite = input.limite === null || input.limite === undefined || input.limite === '';
    return {
      $cat: categoriaId,
      $mes: parseMes(input.desde_mes, { field: 'desde_mes' }),
      $lim: sinLimite ? null : parseImporte(input.limite, { field: 'limite', allowZero: true }),
      $umbral: parseEntero(input.umbral_aviso_pct, {
        field: 'umbral_aviso_pct', label: 'el umbral de aviso', min: 1, max: 100, defecto: 80,
      }),
    };
  }

  /** Inserta o sustituye (misma categoría + mismo mes). Síncrono para poder usarlo en otra transacción. */
  function definirEn(tx, p) {
    const existente = tx.get('SELECT id FROM presupuestos WHERE categoria_id IS $cat AND desde_mes = $mes',
      { $cat: p.$cat, $mes: p.$mes });
    if (existente) {
      tx.run('UPDATE presupuestos SET limite_cent = $lim, umbral_aviso_pct = $umbral WHERE id = $id',
        { $lim: p.$lim, $umbral: p.$umbral, $id: existente.id });
      return existente.id;
    }
    return tx.run(`INSERT INTO presupuestos (categoria_id, desde_mes, limite_cent, umbral_aviso_pct)
                   VALUES ($cat, $mes, $lim, $umbral)`, p).lastId;
  }

  return {
    vigente,
    estadoMes,
    avisosTrasGasto,
    validar,
    definirEn,

    /**
     * Define un presupuesto desde `desde_mes`. limite vacío/null = "sin límite desde este mes"
     * (anula uno anterior); limite 0 = "nada de gasto en esta categoría".
     */
    async definir(input) {
      const p = validar(input);
      const id = await db.transaction((tx) => definirEn(tx, p));
      return db.get('SELECT * FROM presupuestos WHERE id = $id', { $id: id });
    },

    listar() {
      return db.all(`SELECT p.*, c.nombre AS categoria FROM presupuestos p
                     LEFT JOIN categorias c ON c.id = p.categoria_id
                     ORDER BY c.nombre IS NOT NULL, c.nombre, p.desde_mes DESC`);
    },

    async eliminar(id) {
      const pid = parseId(id, { field: 'id', label: 'el presupuesto' });
      existe(db.get('SELECT id FROM presupuestos WHERE id = $id', { $id: pid }), 'El presupuesto no existe.');
      await db.transaction((tx) => tx.run('DELETE FROM presupuestos WHERE id = $id', { $id: pid }));
    },
  };
}
