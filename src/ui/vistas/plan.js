// Plan del mes: de dónde sale cada cifra y propuesta de topes por categoría.
import { estado } from '../estado.js';
import { h, toast, mostrarError } from '../dom.js';
import { euros, selectorMes } from '../piezas.js';
import { mesActual, formatMes } from '../../domain/dates.js';
import { abrirFormularioPrevision } from '../form-ajustes.js';

let mesPlan = null;

const FUENTE = {
  historial: (i) => `el ${i.estrategia === 'media' ? 'promedio' : 'mes más flojo'} de tus últimos ${i.meses_historial} meses`,
  historial_parcial: (i) => `tus ${i.meses_historial} mes(es) apuntados (aún hay poco historial)`,
  previsiones: () => 'tus ingresos previstos (hasta tener 3 meses apuntados)',
};

export function vistaPlan() {
  const { app } = estado;
  mesPlan ??= mesActual();
  const plan = app.plan.calcular(mesPlan);
  const cab = [
    h('div', { class: 'entre' }, h('h1', {}, 'Plan del mes'), h('a', { href: '#/metas', class: 'small' }, 'Metas')),
    selectorMes(mesPlan, (m) => { mesPlan = m; estado.refrescar(); }),
  ];

  if (plan.necesita_estimacion) {
    return [...cab, h('div', { class: 'card' },
      h('p', {}, plan.sugerencias[0].mensaje),
      h('button', { class: 'btn', onclick: () => abrirFormularioPrevision({ tipo: 'ingreso' }) }, 'Indicar mis ingresos'))];
  }

  const t = plan.totales;
  const linea = (texto, valor, { clase = '', fuerte = false } = {}) => h('div', { class: 'entre', style: { padding: '6px 0' } },
    h('span', { class: fuerte ? '' : 'muted' }, texto),
    h(fuerte ? 'strong' : 'span', { class: `num ${clase}` }, valor));

  const recortables = plan.categorias.filter((c) => c.recortable);
  const necesarias = plan.categorias.filter((c) => !c.recortable && c.tope_cent > 0);

  return [
    ...cab,
    plan.sugerencias.map((s) => h('div', { class: `banner ${s.tipo === 'deficit' || s.tipo === 'meta_retrasada' ? 'aviso' : s.tipo === 'excedente' || s.tipo === 'margen' ? 'exito' : 'info'}` }, s.mensaje)),
    h('div', { class: 'card' },
      linea('Ingresos previstos', euros(plan.ingreso.estimado_cent), { fuerte: true }),
      h('p', { class: 'small muted' }, `Calculado con ${FUENTE[plan.ingreso.fuente](plan.ingreso)}.`
        + (plan.ingreso.real_mes_cent ? ` Llevas ingresado ${euros(plan.ingreso.real_mes_cent)} este mes.` : '')),
      linea('− Para tus metas', euros(t.aportes_metas_cent)),
      linea('− Gastos necesarios', euros(t.reservado_no_recortables_cent)),
      t.fijos_recortables_cent ? linea('− Fijos recortables (suscripciones…)', euros(t.fijos_recortables_cent)) : null,
      h('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '6px 0' } }),
      linea(plan.viable ? 'Para caprichos' : 'Te faltan',
        euros(plan.viable ? t.para_recortables_cent - t.fijos_recortables_cent : plan.deficit_cent),
        { fuerte: true, clase: plan.viable ? '' : 'bad' }),
      t.margen_cent ? linea('Te sobra además', euros(t.margen_cent), { clase: 'ok' }) : null),

    plan.metas.length ? [h('h2', {}, 'Metas este mes'), h('div', { class: 'lista' }, plan.metas.map((m) => h('div', {},
      h('div', { style: { flex: 1 } }, h('div', {}, m.nombre),
        h('div', { class: 'small muted' }, m.aportado_mes_cent ? `Llevas ${euros(m.aportado_mes_cent)}` : 'Aún nada este mes')),
      h('span', { class: 'num' }, euros(m.necesario_mes_cent)))))] : null,

    h('h2', {}, 'Topes para caprichos'),
    h('div', { class: 'lista' }, recortables.map((c) => h('div', {},
      h('span', { class: 'icono' }, c.icono ?? '•'),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { class: 'trunc' }, c.nombre),
        h('div', { class: 'small muted' }, `Sueles gastar ${euros(c.media_cent)}${c.fijos_cent ? ` (fijo ${euros(c.fijos_cent)})` : ''} · llevas ${euros(c.gastado_mes_cent)}`)),
      h('strong', { class: `num ${c.tope_cent < c.media_cent ? 'warn' : ''}` }, euros(c.tope_cent))))),
    h('button', {
      class: 'btn bloque',
      onclick: async () => {
        try {
          await app.plan.aceptar(plan.mes);
          toast(`Topes aplicados desde ${formatMes(plan.mes)}. Te avisaré al acercarte a cada uno.`);
          location.hash = '#/inicio';
        } catch (err) { mostrarError(err); }
      },
    }, 'Aplicar estos topes'),
    h('p', { class: 'small muted', style: { margin: '8px 4px 0' } },
      'Se guardan como presupuestos desde este mes y siguen vigentes hasta que apliques otro plan.'),

    h('h2', {}, 'Reservado para lo necesario'),
    h('div', { class: 'lista' }, necesarias.map((c) => h('div', { class: 'small' },
      h('span', { class: 'icono' }, c.icono ?? '•'),
      h('span', { style: { flex: 1 } }, c.nombre),
      h('span', { class: 'num' }, euros(c.tope_cent))))),
    plan.ingreso.meses_historial > 0
      ? h('p', { class: 'small muted', style: { margin: '0 4px' } },
        `A tu ritmo habitual ahorras ${euros(Math.max(0, t.capacidad_ahorro_habitual_cent))} al mes.`)
      : null,
  ];
}
