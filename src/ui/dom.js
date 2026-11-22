// Utilidades de interfaz sin framework.
// h() crea elementos con textContent: el texto del usuario (notas, nombres) nunca se
// interpreta como HTML, así que no hay riesgo de inyección aunque importes datos de fuera.
import { AppError } from '../errors.js';

export function h(tag, attrs = {}, ...hijos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  agregar(el, hijos);
  return el;
}

function agregar(el, hijos) {
  for (const hijo of hijos.flat(Infinity)) {
    if (hijo === null || hijo === undefined || hijo === false) continue;
    el.append(hijo instanceof Node ? hijo : document.createTextNode(String(hijo)));
  }
}

export function vaciar(el, ...hijos) {
  el.replaceChildren();
  agregar(el, hijos);
  return el;
}

// ------------------------------------------------------------------ toasts

export function toast(mensaje, nivel = 'info', ms = 3500) {
  const t = h('div', { class: `toast ${nivel}` }, mensaje);
  const caja = document.getElementById('toasts');
  caja.append(t);
  while (caja.children.length > 3) caja.firstElementChild.remove();
  setTimeout(() => t.remove(), ms);
}

/** Muestra los avisos que devuelven los servicios (presupuesto, disponible negativo…). */
export function mostrarAvisos(avisos = []) {
  for (const a of avisos) toast(a.mensaje, a.nivel === 'info' ? 'info' : a.nivel, 6000);
}

// ------------------------------------------------------------- hojas modales

/**
 * Hoja deslizante (dialog nativo). `contenido(cerrar)` devuelve el cuerpo.
 * Devuelve una promesa que se resuelve al cerrarse.
 */
export function abrirHoja(titulo, contenido) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'hoja' });
    const cerrar = (valor) => { dlg.close(); resolve(valor); };
    dlg.append(
      h('div', { class: 'cabecera' },
        h('h3', {}, titulo),
        h('button', { class: 'enlace', type: 'button', onclick: () => cerrar(null) }, 'Cerrar')),
      h('div', { class: 'cuerpo' }, contenido(cerrar)),
    );
    dlg.addEventListener('close', () => { dlg.remove(); resolve(null); });
    // Tocar fuera de la hoja la cierra
    dlg.addEventListener('click', (e) => { if (e.target === dlg) cerrar(null); });
    document.body.append(dlg);
    dlg.showModal();
    const foco = dlg.querySelector('[autofocus]');
    if (foco) setTimeout(() => foco.focus(), 50);
  });
}

/** Confirmación propia (en lugar de window.confirm) para acciones destructivas. */
export function confirmar(mensaje, { aceptar = 'Eliminar', peligro = true } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'confirmar' });
    const fin = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(
      h('p', {}, mensaje),
      h('div', { class: 'botones' },
        h('button', { class: 'btn sec', type: 'button', onclick: () => fin(false) }, 'Cancelar'),
        h('button', { class: `btn ${peligro ? 'peligro' : ''}`, type: 'button', onclick: () => fin(true) }, aceptar)),
    );
    dlg.addEventListener('cancel', () => fin(false));
    document.body.append(dlg);
    dlg.showModal();
  });
}

// -------------------------------------------------------------- formularios

/**
 * Campo con etiqueta. `name` debe coincidir con el `field` de los errores de los
 * servicios para poder marcarlo en rojo.
 */
export function campo(etiqueta, control, { name = control.name, clase = '' } = {}) {
  return h('label', { class: `campo ${clase}`, dataset: { campo: name } }, h('span', {}, etiqueta), control);
}

export function campoCheck(etiqueta, name, marcado) {
  return h('label', { class: 'campo check', dataset: { campo: name } },
    h('input', { type: 'checkbox', name, checked: !!marcado }), h('span', {}, etiqueta));
}

export function input(name, { tipo = 'text', valor = '', ...attrs } = {}) {
  return h('input', { name, type: tipo, value: valor ?? '', ...attrs });
}

/** Importe: teclado numérico con coma en el iPhone. */
export function inputImporte(name, valor = '', attrs = {}) {
  return h('input', {
    name, type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,00', value: valor ?? '', ...attrs,
  });
}

export function select(name, opciones, valor, attrs = {}) {
  const s = h('select', { name, ...attrs },
    opciones.map(([v, texto]) => h('option', { value: v ?? '' }, texto)));
  s.value = valor ?? '';
  return s;
}

export function limpiarErrores(form) {
  form.querySelectorAll('.campo.error, .rejilla-cat.error').forEach((c) => c.classList.remove('error'));
  form.querySelectorAll('.msg-error').forEach((m) => m.remove());
  form.querySelectorAll('.campo.error, .rejilla-cat.error, [data-campo].error').forEach((c) => c.classList.remove('error'));
}

/**
 * Muestra un error de los servicios: junto a su campo si se conoce, si no como toast.
 * Errores inesperados (bugs) → mensaje genérico + consola.
 */
export function mostrarError(err, form = null) {
  if (err?.silencioso) return; // p. ej. el usuario canceló una confirmación
  if (!(err instanceof AppError)) {
    console.error(err);
    toast('Algo ha fallado. Inténtalo de nuevo.', 'error', 5000);
    return;
  }
  const destino = form && err.field ? form.querySelector(`[data-campo="${CSS.escape(err.field)}"]`) : null;
  if (destino) {
    destino.classList.add('error');
    const msg = h('div', { class: 'msg-error', style: { margin: '-6px 4px 14px' } }, err.message);
    if (destino.tagName === 'LABEL') { msg.style.margin = ''; destino.append(msg); } else destino.after(msg);
    destino.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else {
    toast(err.message, 'error', 5000);
  }
}

/** Envía un formulario: evita dobles toques, limpia errores y los muestra si fallan. */
export function alEnviar(form, accion) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const boton = form.querySelector('[type="submit"]');
    if (boton?.disabled) return;
    if (boton) boton.disabled = true;
    limpiarErrores(form);
    try {
      await accion(new FormData(form));
    } catch (err) {
      mostrarError(err, form);
    } finally {
      if (boton) boton.disabled = false;
    }
  });
  return form;
}

// ------------------------------------------------------------------ piezas

export function barra(uso, nivel = '') {
  const pct = Math.max(0, Math.min(1, uso ?? 0)) * 100;
  return h('div', { class: `barra ${nivel}` }, h('i', { style: { width: `${pct}%` } }));
}

export function vacio(icono, texto, accion = null) {
  return h('div', { class: 'vacio' }, h('span', { class: 'icono-grande' }, icono), h('p', {}, texto), accion);
}

export const PALETA = ['#0a7cff', '#ff9f0a', '#30b158', '#ff375f', '#af52de', '#5ac8fa', '#ffcc00',
  '#a2845e', '#ff6b35', '#64d2ff', '#8e8e93'];
