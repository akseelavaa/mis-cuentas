// Metas de ahorro con su progreso, lo que toca este mes y la proyección a tu ritmo actual.
import { estado } from '../estado.js';
import { h, barra, vacio } from '../dom.js';
import { euros } from '../piezas.js';
import { formatFecha, formatMes } from '../../domain/dates.js';
import { abrirFormularioMeta } from '../form-meta.js';
import { abrirFormularioMovimiento } from '../form-movimiento.js';
import { textoMeta } from './inicio.js';

let verArchivadas = false;

export function vistaMetas() {
  const { app } = estado;
  const plan = app.plan.calcular();
  const proy = new Map((plan.metas ?? []).map((m) => [m.id, m]));
  const metas = app.metas.listar({ incluirArchivadas: verArchivadas });

  return [
    h('div', { class: 'entre' }, h('h1', {}, 'Metas'), h('button', { class: 'btn peq', onclick: () => abrirFormularioMeta() }, '＋ Nueva')),
    h('a', { class: 'card', href: '#/plan', style: { display: 'block', color: 'inherit' } },
      h('div', { class: 'entre' }, h('strong', {}, '📅 Plan del mes'), h('span', { style: { color: 'var(--accent)' } }, '›')),
      h('div', { class: 'small muted' }, plan.necesita_estimacion
        ? 'Indica tus ingresos para calcular cuánto puedes gastar en cada cosa.'
        : `Para tus metas este mes: ${euros(plan.totales.aportes_metas_cent)} · para caprichos: ${euros(plan.totales.para_recortables_cent)}`)),
    metas.length ? metas.map((m) => tarjeta(m, proy.get(m.id))) : vacio('🎯', 'Crea tu primera meta: un iPhone, un viaje, un colchón para imprevistos…'),
    h('button', { class: 'enlace', onclick: () => { verArchivadas = !verArchivadas; estado.refrescar(); } },
      verArchivadas ? 'Ocultar archivadas' : 'Ver archivadas'),
  ];
}

function tarjeta(m, p) {
  const detalles = [];
  if (m.fecha_limite) detalles.push(`Para el ${formatFecha(m.fecha_limite)}`);
  if (m.estado_plan === 'en_curso') detalles.push(`${euros(m.necesario_mes_cent)}/mes`);
  if (m.estado === 'completada') detalles.push('Conseguida');
  if (m.estado === 'archivada') detalles.push('Archivada');

  let ritmo = null;
  if (p?.proyeccion_disponible && m.estado === 'activa' && m.estado_plan !== 'alcanzada') {
    if (p.proyeccion_ritmo_actual) {
      ritmo = h('p', { class: `small ${p.llega_a_tiempo === false ? 'warn' : 'muted'}` },
        `A tu ritmo actual: ${formatMes(p.proyeccion_ritmo_actual)}${p.llega_a_tiempo === false ? ' (tarde: sigue los topes del plan)' : p.llega_a_tiempo ? ' ✓ a tiempo' : ''}`);
    } else if (p.proyeccion_ritmo_actual === null && p.llega_a_tiempo !== true) {
      ritmo = h('p', { class: 'small warn' }, 'Con tus gastos habituales no te sobra para ahorrar: revisa el plan.');
    }
  }

  return h('div', { class: 'card', style: { opacity: m.estado === 'archivada' ? 0.6 : 1 } },
    h('div', { class: 'entre' },
      h('h3', {}, m.nombre),
      h('button', { class: 'enlace', onclick: () => abrirFormularioMeta(m) }, 'Editar')),
    h('div', { class: 'entre' },
      h('span', { class: 'num', style: { fontSize: '22px', fontWeight: 700 } }, euros(m.saldo_cent)),
      h('span', { class: 'num muted' }, `de ${euros(m.objetivo_cent)}`)),
    barra(m.progreso, m.estado_plan === 'alcanzada' || m.estado === 'completada' ? 'ok' : ''),
    h('p', { class: 'small muted', style: { marginTop: '6px' } }, [detalles.join(' · '), m.estado === 'activa' ? ` · ${textoMeta(m)}` : ''].join('')),
    ritmo,
    m.estado !== 'archivada' ? h('div', { class: 'botones' },
      m.estado === 'activa' ? h('button', { class: 'btn peq', onclick: () => abrirFormularioMovimiento({ tipo: 'ahorro_aporte', metaId: m.id }) }, 'Apartar') : null,
      m.saldo_cent > 0 ? h('button', { class: 'btn sec peq', onclick: () => abrirFormularioMovimiento({ tipo: 'ahorro_retiro', metaId: m.id }) }, 'Retirar') : null) : null);
}
