// Inicio: la respuesta a «¿cuánto puedo gastar este mes sin dejar de ahorrar?».
import { estado } from '../estado.js';
import { h, barra, toast, mostrarError } from '../dom.js';
import { euros, filaMovimiento, bannerInstalar } from '../piezas.js';
import { mesActual, formatMes } from '../../domain/dates.js';
import { abrirFormularioMovimiento } from '../form-movimiento.js';
import { abrirFormularioMeta } from '../form-meta.js';
import { abrirFormularioPrevision } from '../form-ajustes.js';
import { bannerCopia } from '../copias.js';

export function vistaInicio() {
  const { app } = estado;
  const mes = mesActual();
  const plan = app.plan.calcular(mes);
  const saldos = app.saldos.calcular();
  const presup = app.presupuestos.estadoMes(mes);
  const recientes = app.movimientos.listar({ limite: 5 }).items;

  return [
    h('h1', {}, 'Este mes'),
    bannerInstalar(),
    bannerCopia(),
    hero(plan),
    avisosPresupuesto(presup),
    tarjetaSaldos(saldos),
    seccionMetas(plan),
    seccionTopes(plan, presup),
    h('h2', {}, 'Últimos movimientos'),
    recientes.length
      ? [h('div', { class: 'lista' }, recientes.map((m) => filaMovimiento(m, { conFecha: true }))),
        h('a', { href: '#/movimientos', class: 'small' }, 'Ver todos →')]
      : h('div', { class: 'card muted' }, 'Aún no has apuntado nada. Toca ＋ para empezar.'),
  ];
}

function hero(plan) {
  if (plan.necesita_estimacion) {
    return h('div', { class: 'card hero' },
      h('h3', {}, '¿Cuánto sueles ganar al mes?'),
      h('p', { class: 'muted' }, 'Con eso calculo cuánto puedes gastar en cada cosa sin dejar de ahorrar. Cuando tengas unos meses apuntados, lo calcularé con tus ingresos reales.'),
      h('button', {
        class: 'btn',
        onclick: () => abrirFormularioPrevision({ tipo: 'ingreso' }),
      }, 'Indicar mis ingresos'));
  }
  const { ritmo } = plan;
  return h('a', { class: 'card hero', href: '#/plan', style: { display: 'block', color: 'inherit' } },
    h('div', { class: 'muted' }, 'Puedes gastar en caprichos'),
    h('div', { class: `grande num ${ritmo.restante_variable_cent === 0 ? 'bad' : ''}` }, euros(ritmo.restante_variable_cent)),
    ritmo.dias_restantes > 0
      ? h('div', { class: 'muted' }, `≈ ${euros(ritmo.por_dia_cent)} al día · quedan ${ritmo.dias_restantes} días`)
      : null,
    plan.ingreso.meses_historial === 0
      ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Orientativo: aún no hay meses completos apuntados.')
      : null,
    !plan.viable
      ? h('div', { class: 'banner superado', style: { margin: '12px 0 0' } },
        `Este mes no llega: faltan ${euros(plan.deficit_cent)} para tus gastos necesarios y tus metas.`)
      : null,
    h('div', { class: 'small', style: { marginTop: '10px', color: 'var(--accent)' } }, 'Ver el plan del mes →'));
}

function avisosPresupuesto(presup) {
  const alertas = [
    ...(presup.general.nivel === 'superado' || presup.general.nivel === 'aviso' ? [{ nombre: 'Límite general', ...presup.general }] : []),
    ...presup.categorias.filter((c) => c.nivel === 'aviso' || c.nivel === 'superado'),
  ];
  return alertas.map((c) => h('div', { class: `banner ${c.nivel}` },
    c.icono ? `${c.icono} ` : '',
    h('strong', {}, c.nombre), ': ',
    c.nivel === 'superado'
      ? `te has pasado ${euros(-c.restante_cent)} (${euros(c.gastado_cent)} de ${euros(c.limite_cent)}).`
      : `te quedan ${euros(c.restante_cent)} de ${euros(c.limite_cent)}.`));
}

function tarjetaSaldos(s) {
  const total = Math.max(1, Math.max(0, s.disponible_cent) + s.reservado_cent);
  return h('div', { class: 'card' },
    h('div', { class: 'entre' },
      h('div', {}, h('div', { class: 'muted small' }, 'Disponible para gastar'),
        h('div', { class: `num ${s.disponible_cent < 0 ? 'bad' : ''}`, style: { fontSize: '22px', fontWeight: 700 } }, euros(s.disponible_cent))),
      h('div', { style: { textAlign: 'right' } }, h('div', { class: 'muted small' }, 'Apartado en metas'),
        h('div', { class: 'num', style: { fontSize: '22px', fontWeight: 700 } }, euros(s.reservado_cent)))),
    h('div', { class: 'reparto' },
      h('i', { style: { width: `${(Math.max(0, s.disponible_cent) / total) * 100}%`, background: 'var(--accent)' } }),
      h('i', { style: { width: `${(s.reservado_cent / total) * 100}%`, background: 'var(--ok)' } })),
    s.disponible_cent < 0
      ? h('p', { class: 'small bad' }, 'Has gastado parte de lo que tenías apartado. Si es así, registra un retiro de la meta.')
      : null);
}

function seccionMetas(plan) {
  const metas = plan.metas;
  if (!metas.length) {
    return [h('h2', {}, 'Metas'),
      h('div', { class: 'card' },
        h('p', {}, '¿Ahorras para algo? Crea una meta y te diré cuánto apartar cada mes.'),
        h('button', { class: 'btn sec', onclick: () => abrirFormularioMeta() }, 'Crear meta'))];
  }
  return [h('h2', {}, 'Metas'), metas.map((m) => h('div', { class: 'card' },
    h('div', { class: 'entre' }, h('h3', {}, m.nombre), h('span', { class: 'num muted' }, `${euros(m.saldo_cent)} / ${euros(m.objetivo_cent)}`)),
    barra(m.progreso, m.estado_plan === 'alcanzada' ? 'ok' : ''),
    h('div', { class: 'entre', style: { marginTop: '8px' } },
      h('span', { class: 'small muted' }, textoMeta(m)),
      m.estado_plan !== 'alcanzada'
        ? h('button', { class: 'btn peq', onclick: () => abrirFormularioMovimiento({ tipo: 'ahorro_aporte', metaId: m.id }) }, 'Apartar')
        : null)))];
}

export function textoMeta(m) {
  switch (m.estado_plan) {
    case 'alcanzada': return '¡Conseguida! 🎉';
    case 'en_curso':
      return m.pendiente_mes_cent > 0
        ? `Este mes: aparta ${euros(m.pendiente_mes_cent)} más`
        : `Este mes ya has apartado lo necesario ✓`;
    case 'vencida': return `La fecha ya pasó: faltan ${euros(m.falta_cent)}`;
    case 'cuota': return m.pendiente_mes_cent > 0 ? `Cuota del mes: faltan ${euros(m.pendiente_mes_cent)}` : 'Cuota del mes cumplida ✓';
    case 'sin_fecha': return `Faltan ${euros(m.falta_cent)} · sin fecha`;
    default: return '';
  }
}

function seccionTopes(plan, presup) {
  const conLimite = presup.categorias.filter((c) => c.limite_cent !== null);
  if (conLimite.length) {
    return [h('h2', {}, `Tus topes de ${formatMes(presup.mes).split(' ')[0]}`),
      h('div', { class: 'lista' }, conLimite.map((c) => h('div', { style: { display: 'block' } },
        h('div', { class: 'entre' },
          h('span', {}, `${c.icono ?? ''} ${c.nombre}`),
          h('span', { class: 'num small' }, `${euros(c.gastado_cent)} / ${euros(c.limite_cent)}`)),
        barra(c.uso ?? (c.gastado_cent > 0 ? 1 : 0), c.nivel === 'ok' ? '' : c.nivel))))];
  }
  if (plan.necesita_estimacion) return null;
  return [h('h2', {}, 'Topes sugeridos'),
    h('div', { class: 'card' },
      h('p', {}, 'Aún no has fijado topes por categoría. El plan del mes te propone unos para llegar a tus metas.'),
      h('div', { class: 'botones' },
        h('a', { class: 'btn sec', href: '#/plan' }, 'Ver propuesta'),
        h('button', {
          class: 'btn',
          onclick: async () => {
            try { await estado.app.plan.aceptar(); toast('Topes aplicados'); estado.refrescar(); } catch (err) { mostrarError(err); }
          },
        }, 'Aplicar')))];
}
