// En qué se va el dinero: resumen del mes, reparto por categoría y evolución.
import { estado } from '../estado.js';
import { h, vacio, PALETA } from '../dom.js';
import { euros, pct, selectorMes } from '../piezas.js';
import { sumarMeses } from '../../domain/dates.js';

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function vistaAnalisis() {
  const { app } = estado;
  const mes = estado.mes;
  const r = app.analitica.resumenMensual(mes);
  const d = app.analitica.desgloseGastos(mes);
  const evo = app.analitica.evolucion(sumarMeses(mes, -5), mes);

  return [
    h('h1', {}, 'En qué gasto'),
    selectorMes(mes, (m) => { estado.mes = m; estado.refrescar(); }),
    resumen(r),
    h('h2', {}, 'Por categoría'),
    d.categorias.some((c) => c.gastado_cent > 0) ? reparto(d) : h('div', { class: 'card' }, vacio('📊', 'No hay gastos este mes.')),
    h('h2', {}, 'Últimos 6 meses'),
    evolucion(evo),
  ];
}

function resumen(r) {
  const dato = (titulo, valor, clase = '') => h('div', {},
    h('div', { class: 'muted small' }, titulo), h('div', { class: `num ${clase}`, style: { fontSize: '20px', fontWeight: 700 } }, valor));
  return h('div', { class: 'card', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' } },
    dato('Ingresos', euros(r.ingresos_cent), 'ok'),
    dato('Gastos', euros(r.gastos_cent)),
    dato('Ahorro neto', euros(r.ahorro_neto_cent), r.ahorro_neto_cent < 0 ? 'bad' : ''),
    dato('Tasa de ahorro', pct(r.tasa_ahorro), r.tasa_ahorro !== null && r.tasa_ahorro < 0 ? 'bad' : ''),
    r.aportado_metas_cent || r.retirado_metas_cent
      ? h('div', { class: 'small muted', style: { gridColumn: '1 / -1' } },
        `Apartado en metas: ${euros(r.aportado_metas_cent)}${r.retirado_metas_cent ? ` · retirado: ${euros(r.retirado_metas_cent)}` : ''}`)
      : null);
}

function reparto(d) {
  const cats = d.categorias.filter((c) => c.gastado_cent > 0);
  let acum = 0;
  const tramos = cats.map((c, i) => {
    const ini = acum;
    acum += c.porcentaje * 360;
    return `${PALETA[i % PALETA.length]} ${ini}deg ${acum}deg`;
  });
  return [
    h('div', { class: 'card donut-caja' },
      h('div', { class: 'donut', role: 'img', 'aria-label': 'Reparto de gastos por categoría', style: { background: `conic-gradient(${tramos.join(', ')})` } }),
      h('div', {}, h('div', { class: 'muted small' }, 'Total gastado'), h('div', { class: 'num', style: { fontSize: '24px', fontWeight: 700 } }, euros(d.total_cent)),
        cats[0] ? h('div', { class: 'small muted' }, `Lo que más: ${cats[0].nombre} (${pct(cats[0].porcentaje)})`) : null)),
    h('div', { class: 'lista' }, d.categorias.map((c, i) => h('div', {},
      h('span', { class: 'punto', style: { background: c.gastado_cent > 0 ? PALETA[i % PALETA.length] : 'var(--track)' } }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { class: 'trunc' }, `${c.icono ?? ''} ${c.nombre}`),
        h('div', { class: 'small muted' }, comparacion(c))),
      h('div', { style: { textAlign: 'right' } },
        h('div', { class: 'num' }, euros(c.gastado_cent)),
        h('div', { class: 'small muted' }, pct(c.porcentaje)))))),
  ];
}

function comparacion(c) {
  if (c.mes_anterior_cent === 0) return 'Nuevo este mes';
  if (c.diferencia_cent === 0) return 'Igual que el mes pasado';
  const signo = c.diferencia_cent > 0 ? '▲' : '▼';
  return `${signo} ${euros(Math.abs(c.diferencia_cent))} vs. mes pasado`;
}

function evolucion(serie) {
  const max = Math.max(1, ...serie.flatMap((s) => [s.ingresos_cent, s.gastos_cent]));
  const alto = (v) => `${(v / max) * 100}%`;
  return h('div', { class: 'card' },
    h('div', { class: 'evolucion', role: 'img', 'aria-label': 'Ingresos y gastos de los últimos 6 meses' }, serie.map((s) => h('div', { class: 'mes' },
      h('div', { class: 'pares' },
        h('i', { title: `Ingresos ${euros(s.ingresos_cent)}`, style: { height: alto(s.ingresos_cent), background: 'var(--ok)' } }),
        h('i', { title: `Gastos ${euros(s.gastos_cent)}`, style: { height: alto(s.gastos_cent), background: 'var(--accent)' } })),
      h('span', { class: 'etq' }, MESES_CORTOS[Number(s.mes.slice(5)) - 1])))),
    h('div', { class: 'leyenda' },
      h('span', {}, h('span', { class: 'punto', style: { background: 'var(--ok)' } }), ' Ingresos'),
      h('span', {}, h('span', { class: 'punto', style: { background: 'var(--accent)' } }), ' Gastos')),
    h('div', { class: 'lista', style: { marginTop: '12px', marginBottom: 0 } }, serie.slice().reverse().map((s) => h('div', { class: 'small' },
      h('span', { style: { flex: 1 } }, `${MESES_CORTOS[Number(s.mes.slice(5)) - 1]} ${s.mes.slice(0, 4)}`),
      h('span', { class: `num ${s.ahorro_neto_cent < 0 ? 'bad' : 'ok'}` }, `${s.ahorro_neto_cent >= 0 ? '+' : ''}${euros(s.ahorro_neto_cent)}`)))));
}
