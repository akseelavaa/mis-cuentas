// Plan mensual: ¿cuánto puedo gastar en cada cosa sin dejar de ahorrar para mis metas?
//
// 1. Ingreso estimado (tus ingresos varían):
//      - con ≥ N meses completos de historial: el MÍNIMO de esos meses (prudente)
//        o la media, según el ajuste `estrategia_ingresos`;
//      - con menos historial: tus ingresos previstos (previsiones) si los has definido;
//        si no, lo que haya de historial;
//      - sin nada: el plan pide que indiques una estimación.
//    El primer mes de uso solo cuenta si empezaste a apuntar antes del día 4
//    (un mes a medias infravaloraría ingresos y gastos).
// 2. Se reserva, por orden:
//      a) lo que toca aportar este mes a cada meta activa;
//      b) categorías NO recortables: max(media histórica, gastos fijos previstos);
//      c) categorías recortables: al menos sus gastos fijos (p. ej. suscripciones).
// 3. Lo que queda se reparte entre las recortables en proporción a lo que sueles gastar
//    por encima de sus fijos. Si sobra respecto a tu gasto habitual, ese margen se
//    muestra como ahorro extra posible (no se infla ningún tope).
// 4. Si no llega: el plan no es viable, se indica cuánto falta y cuándo llegarías a
//    cada meta manteniendo tus hábitos actuales.
import { BusinessRuleError } from '../errors.js';
import { repartirProporcional, formatImporte } from '../domain/money.js';
import {
  parseMes, rangoMes, sumarMeses, mesActual, mesDe, hoy, diasEnMes, formatMes,
} from '../domain/dates.js';

export function makePlan(ctx) {
  const { db } = ctx;

  function mesesHistorial(mes, n) {
    const primera = db.value("SELECT min(fecha) FROM movimientos WHERE tipo IN ('gasto','ingreso')");
    if (!primera) return [];
    const primerMesCompleto = Number(primera.slice(8, 10)) <= 3 ? mesDe(primera) : sumarMeses(mesDe(primera), 1);
    const meses = [];
    for (let i = n; i >= 1; i--) {
      const mm = sumarMeses(mes, -i);
      if (mm >= primerMesCompleto) meses.push(mm);
    }
    return meses;
  }

  function totalesPorMes(meses) {
    if (meses.length === 0) return { ingresos: {}, gastosCat: {} };
    const desde = `${meses[0]}-01`;
    const hasta = `${sumarMeses(meses.at(-1), 1)}-01`;
    const filas = db.all(`SELECT substr(fecha, 1, 7) AS mes, tipo, categoria_id, SUM(importe_cent) AS total
      FROM movimientos WHERE tipo IN ('gasto','ingreso') AND fecha >= $d AND fecha < $h
      GROUP BY mes, tipo, categoria_id`, { $d: desde, $h: hasta });
    const ingresos = {};
    const gastosCat = {};
    for (const f of filas) {
      if (f.tipo === 'ingreso') ingresos[f.mes] = (ingresos[f.mes] ?? 0) + f.total;
      else gastosCat[f.categoria_id] = (gastosCat[f.categoria_id] ?? 0) + f.total;
    }
    return { ingresos, gastosCat };
  }

  function estimarIngreso(meses, ingresosPorMes, n, estrategia) {
    const valores = meses.map((mm) => ingresosPorMes[mm] ?? 0);
    const deHistorial = () => (estrategia === 'media'
      ? Math.round(valores.reduce((a, b) => a + b, 0) / valores.length)
      : Math.min(...valores));
    const previstos = Object.values(ctx.previsiones.porCategoria('ingreso')).reduce((a, b) => a + b, 0);

    if (valores.length >= n) return { estimado_cent: deHistorial(), fuente: 'historial' };
    if (previstos > 0) return { estimado_cent: previstos, fuente: 'previsiones' };
    if (valores.length > 0) return { estimado_cent: deHistorial(), fuente: 'historial_parcial' };
    return { estimado_cent: null, fuente: 'sin_datos' };
  }

  function calcular(mes = mesActual(ctx.now())) {
    const m = parseMes(mes);
    const n = ctx.ajustes.getNumero('meses_historial', 3);
    const estrategia = ctx.ajustes.get('estrategia_ingresos') === 'media' ? 'media' : 'minimo';
    const { desde, hasta } = rangoMes(m);

    const meses = mesesHistorial(m, n);
    const { ingresos: ingresosHist, gastosCat } = totalesPorMes(meses);
    const ingreso = estimarIngreso(meses, ingresosHist, n, estrategia);
    const realMes = db.value(`SELECT COALESCE(SUM(importe_cent), 0) FROM movimientos
                              WHERE tipo = 'ingreso' AND fecha >= $d AND fecha < $h`, { $d: desde, $h: hasta });
    ingreso.real_mes_cent = realMes;
    ingreso.meses_historial = meses.length;
    ingreso.estrategia = estrategia;
    ingreso.excedente_cent = ingreso.estimado_cent === null ? 0 : Math.max(0, realMes - ingreso.estimado_cent);

    // ---- categorías de gasto
    const fijos = ctx.previsiones.porCategoria('gasto');
    const gastadoMes = Object.fromEntries(db.all(`SELECT categoria_id, SUM(importe_cent) AS t FROM movimientos
      WHERE tipo = 'gasto' AND fecha >= $d AND fecha < $h GROUP BY categoria_id`, { $d: desde, $h: hasta })
      .map((f) => [f.categoria_id, f.t]));
    const categorias = db.all("SELECT id, nombre, icono, recortable FROM categorias WHERE tipo = 'gasto' AND activa = 1 ORDER BY nombre")
      .map((c) => ({
        categoria_id: c.id,
        nombre: c.nombre,
        icono: c.icono,
        recortable: c.recortable,
        media_cent: meses.length ? Math.round((gastosCat[c.id] ?? 0) / meses.length) : 0,
        fijos_cent: fijos[c.id] ?? 0,
        gastado_mes_cent: gastadoMes[c.id] ?? 0,
      }));

    // ---- metas
    const metas = ctx.metas.listar({ mes: m }).filter((x) => x.estado === 'activa');
    const aportes = metas.reduce((a, x) => a + x.necesario_mes_cent, 0);

    const base = { mes: m, ingreso, metas, categorias };
    if (ingreso.estimado_cent === null) {
      return {
        ...base,
        necesita_estimacion: true,
        sugerencias: [{
          tipo: 'sin_datos',
          mensaje: 'Aún no hay historial de ingresos. Añade una previsión de ingresos (lo que esperas ganar al mes) para calcular el plan.',
        }],
      };
    }

    // ---- reparto
    const noRec = categorias.filter((c) => !c.recortable);
    const rec = categorias.filter((c) => c.recortable);
    // Lo necesario se reserva entero: al menos su media, sus fijos y lo que ya llevas este mes.
    for (const c of noRec) c.tope_cent = Math.max(c.media_cent, c.fijos_cent, c.gastado_mes_cent);
    const reservaNoRec = noRec.reduce((a, c) => a + c.tope_cent, 0);
    const fijosRec = rec.reduce((a, c) => a + c.fijos_cent, 0);
    const margenBruto = ingreso.estimado_cent - aportes - reservaNoRec - fijosRec;

    const excesos = rec.map((c) => Math.max(0, c.media_cent - c.fijos_cent));
    const sumaExcesos = excesos.reduce((a, b) => a + b, 0);
    let extras = rec.map(() => 0);
    let margen = 0;
    if (margenBruto >= 0) {
      if (sumaExcesos === 0 && meses.length === 0) {
        extras = repartirProporcional(margenBruto, rec.map(() => 1)); // sin historial: a partes iguales
      } else if (margenBruto >= sumaExcesos) {
        extras = excesos;
        margen = margenBruto - sumaExcesos;
      } else {
        extras = repartirProporcional(margenBruto, excesos);
      }
    }
    rec.forEach((c, i) => { c.tope_cent = c.fijos_cent + extras[i]; });
    for (const c of categorias) c.restante_cent = c.tope_cent - c.gastado_mes_cent;

    const viable = margenBruto >= 0;
    const deficit = viable ? 0 : -margenBruto;

    // ---- proyección "a tu ritmo actual" (por prioridad, una meta tras otra)
    const gastoHabitual = categorias.reduce((a, c) => a + Math.max(c.media_cent, c.fijos_cent), 0);
    const capacidad = ingreso.estimado_cent - gastoHabitual;
    let acumulado = 0;
    for (const meta of metas) {
      // Sin historial no sabemos tu ritmo: no se proyecta (evita un falso «llegas a tiempo»).
      meta.proyeccion_disponible = meses.length > 0;
      if (!meta.proyeccion_disponible) {
        meta.proyeccion_ritmo_actual = null;
        meta.llega_a_tiempo = null;
        continue;
      }
      if (meta.estado_plan === 'alcanzada' || meta.falta_inicio_mes_cent === 0) {
        meta.proyeccion_ritmo_actual = null;
        meta.llega_a_tiempo = true;
        continue;
      }
      acumulado += meta.falta_inicio_mes_cent;
      meta.proyeccion_ritmo_actual = capacidad > 0 ? sumarMeses(m, Math.ceil(acumulado / capacidad) - 1) : null;
      meta.llega_a_tiempo = meta.fecha_limite
        ? meta.proyeccion_ritmo_actual !== null && meta.proyeccion_ritmo_actual <= mesDe(meta.fecha_limite)
        : null;
    }

    // ---- ritmo diario del mes
    const actual = mesActual(ctx.now());
    const [y, mm] = m.split('-').map(Number);
    let diasRestantes;
    if (m === actual) diasRestantes = diasEnMes(y, mm) - Number(hoy(ctx.now()).slice(8, 10)) + 1;
    else diasRestantes = m < actual ? 0 : diasEnMes(y, mm);
    const restanteVariable = rec.reduce((a, c) => a + Math.max(0, c.restante_cent), 0);

    return {
      ...base,
      necesita_estimacion: false,
      viable,
      deficit_cent: deficit,
      totales: {
        aportes_metas_cent: aportes,
        reservado_no_recortables_cent: reservaNoRec,
        fijos_recortables_cent: fijosRec,
        para_recortables_cent: Math.max(0, margenBruto) + fijosRec - margen,
        margen_cent: margen,
        capacidad_ahorro_habitual_cent: capacidad,
      },
      ritmo: {
        dias_restantes: diasRestantes,
        restante_variable_cent: restanteVariable,
        por_dia_cent: diasRestantes > 0 ? Math.floor(restanteVariable / diasRestantes) : 0,
      },
      sugerencias: sugerencias({
        ingreso, viable, deficit, margen, metas, capacidad, n, hayFijos: Object.keys(fijos).length > 0,
      }),
    };
  }

  function sugerencias({ ingreso, viable, deficit, margen, metas, capacidad, n, hayFijos }) {
    const out = [];
    if (ingreso.meses_historial < n) {
      out.push({
        tipo: 'poco_historial',
        mensaje: `Llevas ${ingreso.meses_historial} de ${n} meses completos apuntados: los topes son orientativos y se irán ajustando a tus gastos reales.`
          + (hayFijos ? '' : ' Añade tus gastos fijos (alquiler, facturas…) en Ajustes para que sean realistas desde ya.'),
      });
    }
    const principal = metas.find((x) => x.falta_inicio_mes_cent > 0 && x.estado_plan !== 'alcanzada');
    if (!viable) {
      out.push({
        tipo: 'deficit',
        mensaje: `Con ${formatImporte(ingreso.estimado_cent)} de ingresos previstos faltan ${formatImporte(deficit)} `
          + 'para cubrir tus gastos necesarios y tus metas, incluso sin caprichos.',
      });
    }
    for (const meta of metas) {
      if (meta.llega_a_tiempo === false) {
        out.push({
          tipo: 'meta_retrasada',
          meta_id: meta.id,
          mensaje: meta.proyeccion_ritmo_actual
            ? `A tu ritmo actual tendrías «${meta.nombre}» en ${formatMes(meta.proyeccion_ritmo_actual)}. `
              + `Para llegar a tiempo, ajústate a los topes del plan este mes.`
            : `Con tus gastos habituales ahora mismo no ahorras: no llegarías a «${meta.nombre}» sin recortar.`,
        });
      }
      if (meta.estado_plan === 'vencida') {
        out.push({
          tipo: 'meta_vencida',
          meta_id: meta.id,
          mensaje: `La fecha de «${meta.nombre}» ya pasó. Ponle una fecha nueva para repartir lo que falta.`,
        });
      }
    }
    if (ingreso.excedente_cent > 0 && principal) {
      out.push({
        tipo: 'excedente',
        meta_id: principal.id,
        mensaje: `Este mes has ingresado ${formatImporte(ingreso.excedente_cent)} más de lo previsto. `
          + `Si los apartas en «${principal.nombre}», llegarás antes.`,
      });
    }
    if (margen > 0 && capacidad > 0 && ingreso.meses_historial > 0) {
      out.push({
        tipo: 'margen',
        mensaje: `Con tus gastos habituales te sobran ${formatImporte(margen)} al mes además de lo que ya apartas.`,
      });
    }
    return out;
  }

  /**
   * Guarda los topes del plan como presupuestos de las categorías recortables desde `mes`.
   * Respeta el umbral de aviso que ya tuviera cada categoría.
   */
  async function aceptar(mes = mesActual(ctx.now())) {
    const plan = calcular(mes);
    if (plan.necesita_estimacion) {
      throw new BusinessRuleError('Aún no se puede calcular el plan: añade una previsión de ingresos.', { code: 'plan_sin_datos' });
    }
    await db.transaction((tx) => {
      for (const c of plan.categorias.filter((x) => x.recortable)) {
        const previo = ctx.presupuestos.vigente(c.categoria_id, plan.mes, tx);
        ctx.presupuestos.definirEn(tx, {
          $cat: c.categoria_id, $mes: plan.mes, $lim: c.tope_cent, $umbral: previo?.umbral_aviso_pct ?? 80,
        });
      }
    });
    return ctx.presupuestos.estadoMes(plan.mes);
  }

  return { calcular, aceptar };
}
