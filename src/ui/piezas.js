// Piezas de interfaz reutilizadas por varias pantallas.
import { estado } from './estado.js';
import { h } from './dom.js';
import { formatImporte } from '../domain/money.js';
import { formatMes, sumarMeses, formatFecha, hoy } from '../domain/dates.js';
import { abrirFormularioMovimiento } from './form-movimiento.js';

export const euros = formatImporte;

export function pct(ratio) {
  return ratio === null || ratio === undefined ? 'n/d' : `${Math.round(ratio * 100)} %`;
}

export const capitalizar = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function selectorMes(mes, alCambiar) {
  return h('div', { class: 'selector-mes' },
    h('button', { type: 'button', 'aria-label': 'Mes anterior', onclick: () => alCambiar(sumarMeses(mes, -1)) }, '‹'),
    h('strong', {}, capitalizar(formatMes(mes))),
    h('button', { type: 'button', 'aria-label': 'Mes siguiente', onclick: () => alCambiar(sumarMeses(mes, 1)) }, '›'));
}

const SIGNO = { gasto: '−', ingreso: '+', ahorro_aporte: '→', ahorro_retiro: '←' };
const CLASE = { gasto: '', ingreso: 'ok', ahorro_aporte: 'muted', ahorro_retiro: 'muted' };

/** Fila de la lista de movimientos; al tocarla se abre para editar. */
export function filaMovimiento(m, { conFecha = false } = {}) {
  const titulo = m.tipo.startsWith('ahorro')
    ? `${m.tipo === 'ahorro_aporte' ? 'Apartado para' : 'Retirado de'} ${m.meta}`
    : m.categoria;
  const sub = [conFecha ? formatFecha(m.fecha) : null, m.nota].filter(Boolean).join(' · ');
  return h('button', { type: 'button', onclick: () => abrirFormularioMovimiento({ movimiento: m }) },
    h('span', { class: 'icono' }, m.tipo.startsWith('ahorro') ? '🎯' : (m.categoria_icono || '•')),
    h('div', { class: 'crece', style: { minWidth: 0, flex: 1 } },
      h('div', { class: 'trunc' }, titulo),
      sub ? h('div', { class: 'muted small trunc' }, sub) : null),
    h('span', { class: `num ${CLASE[m.tipo]}` }, `${SIGNO[m.tipo]} ${euros(m.importe_cent)}`));
}

/** Días relativos legibles para las cabeceras de la lista. */
export function etiquetaDia(fecha) {
  const d = hoy();
  if (fecha === d) return 'Hoy';
  const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);
  if (fecha === hoy(ayer)) return 'Ayer';
  const [y, m, dd] = fecha.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

const esIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const instalada = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/**
 * En iPhone, Safari puede borrar los datos de una web que no visitas en 7 días.
 * Las apps añadidas a la pantalla de inicio están exentas: hay que insistir en instalarla.
 */
export function bannerInstalar() {
  if (instalada()) return null;
  if (esIOS()) {
    return h('div', { class: 'banner aviso' },
      h('strong', {}, 'Instálala para no perder tus datos. '),
      'En Safari, toca Compartir ', h('span', { 'aria-hidden': 'true' }, '⬆︎'),
      ' y luego «Añadir a pantalla de inicio». Ábrela siempre desde ese icono.');
  }
  return null;
}

export function estadoInstalacion() {
  return { instalada: instalada(), ios: esIOS(), persistente: estado.persistente };
}
