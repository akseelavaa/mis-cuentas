// Resúmenes: mes, desglose por categoría y evolución.
import { ValidationError } from '../errors.js';
import { parseMes, rangoMes, sumarMeses, mesesEntre } from '../domain/dates.js';

export function makeAnalitica(ctx) {
  const { db } = ctx;

  /**
   * ahorro neto = ingresos − gastos. Los aportes a metas son una reasignación, no un gasto:
   * se muestran aparte. tasa_ahorro = ahorro / ingresos, o null si no hubo ingresos.
   */
  function resumenMensual(mes) {
    const m = parseMes(mes);
    const { desde, hasta } = rangoMes(m);
    const r = db.get(`SELECT
        COALESCE(SUM(CASE tipo WHEN 'ingreso'       THEN importe_cent END), 0) AS ingresos,
        COALESCE(SUM(CASE tipo WHEN 'gasto'         THEN importe_cent END), 0) AS gastos,
        COALESCE(SUM(CASE tipo WHEN 'ahorro_aporte' THEN importe_cent END), 0) AS aportado,
        COALESCE(SUM(CASE tipo WHEN 'ahorro_retiro' THEN importe_cent END), 0) AS retirado
      FROM movimientos WHERE fecha >= $desde AND fecha < $hasta`, { $desde: desde, $hasta: hasta });
    const ahorro = r.ingresos - r.gastos;
    return {
      mes: m,
      ingresos_cent: r.ingresos,
      gastos_cent: r.gastos,
      ahorro_neto_cent: ahorro,
      tasa_ahorro: r.ingresos > 0 ? ahorro / r.ingresos : null,
      aportado_metas_cent: r.aportado,
      retirado_metas_cent: r.retirado,
    };
  }

  /** Gasto por categoría en `mes`, con % del total y comparación con el mes anterior. */
  function desgloseGastos(mes) {
    const m = parseMes(mes);
    const actual = rangoMes(m);
    const anterior = rangoMes(sumarMeses(m, -1));
    const filas = db.all(`
      SELECT c.id AS categoria_id, c.nombre, c.icono, c.recortable,
        COALESCE(SUM(CASE WHEN mv.fecha >= $d1 AND mv.fecha < $h1 THEN mv.importe_cent END), 0) AS gastado,
        COALESCE(SUM(CASE WHEN mv.fecha >= $d0 AND mv.fecha < $h0 THEN mv.importe_cent END), 0) AS anterior
      FROM movimientos mv JOIN categorias c ON c.id = mv.categoria_id
      WHERE mv.tipo = 'gasto' AND mv.fecha >= $d0 AND mv.fecha < $h1
      GROUP BY c.id
      HAVING gastado > 0 OR anterior > 0
      ORDER BY gastado DESC, anterior DESC, c.nombre`,
    { $d0: anterior.desde, $h0: anterior.hasta, $d1: actual.desde, $h1: actual.hasta });

    const total = filas.reduce((a, f) => a + f.gastado, 0);
    return {
      mes: m,
      total_cent: total,
      categorias: filas.map((f) => ({
        categoria_id: f.categoria_id,
        nombre: f.nombre,
        icono: f.icono,
        recortable: f.recortable,
        gastado_cent: f.gastado,
        porcentaje: total > 0 ? f.gastado / total : 0,
        mes_anterior_cent: f.anterior,
        diferencia_cent: f.gastado - f.anterior,
      })),
    };
  }

  /** Serie mensual [desde..hasta] con meses vacíos rellenados a 0. Máx. 60 meses. */
  function evolucion(desdeMes, hastaMes, { categoria_id: categoriaId = null } = {}) {
    const d = parseMes(desdeMes, { field: 'desde' });
    const h = parseMes(hastaMes, { field: 'hasta' });
    const n = mesesEntre(d, h);
    if (n < 0) throw new ValidationError('El mes inicial es posterior al final.', { code: 'rango_meses', field: 'desde' });
    if (n >= 60) throw new ValidationError('Elige un rango de 60 meses como máximo.', { code: 'rango_meses', field: 'desde' });

    const params = { $desde: `${d}-01`, $hasta: `${sumarMeses(h, 1)}-01` };
    let filtroCat = '';
    if (categoriaId !== null) { filtroCat = 'AND categoria_id = $cat'; params.$cat = Number(categoriaId); }

    const filas = db.all(`SELECT substr(fecha, 1, 7) AS mes,
        COALESCE(SUM(CASE tipo WHEN 'ingreso' THEN importe_cent END), 0) AS ingresos,
        COALESCE(SUM(CASE tipo WHEN 'gasto'   THEN importe_cent END), 0) AS gastos
      FROM movimientos WHERE fecha >= $desde AND fecha < $hasta ${filtroCat}
      GROUP BY mes`, params);
    const porMes = new Map(filas.map((f) => [f.mes, f]));

    return Array.from({ length: n + 1 }, (_, i) => {
      const mes = sumarMeses(d, i);
      const f = porMes.get(mes) ?? { ingresos: 0, gastos: 0 };
      return { mes, ingresos_cent: f.ingresos, gastos_cent: f.gastos, ahorro_neto_cent: f.ingresos - f.gastos };
    });
  }

  return { resumenMensual, desgloseGastos, evolucion };
}
