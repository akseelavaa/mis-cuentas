// Arranque de la app: SQLite (sql.js) → servicios → router.
import { Database } from '../db/connection.js';
import { createIdbStorage, solicitarPersistencia } from '../db/storage-idb.js';
import { createServices } from '../services/index.js';
import { estado } from './estado.js';
import { vaciar, h, toast } from './dom.js';
import { abrirFormularioMovimiento } from './form-movimiento.js';
import { vistaInicio } from './vistas/inicio.js';
import { vistaMovimientos } from './vistas/movimientos.js';
import { vistaAnalisis } from './vistas/analisis.js';
import { vistaMetas } from './vistas/metas.js';
import { vistaPlan } from './vistas/plan.js';
import { vistaAjustes } from './vistas/ajustes.js';
import { vistaBienvenida } from './vistas/bienvenida.js';

const RUTAS = {
  inicio: vistaInicio,
  movimientos: vistaMovimientos,
  analisis: vistaAnalisis,
  metas: vistaMetas,
  plan: vistaPlan,
  ajustes: vistaAjustes,
};

const $vista = document.getElementById('vista');
const $tabs = document.getElementById('tabs');
const $fab = document.getElementById('fab');
const $arranque = document.getElementById('arranque');

async function arrancar() {
  if (typeof window.initSqlJs !== 'function') throw new Error('No se pudo cargar SQLite (vendor/sql-wasm.js).');
  const SQL = await window.initSqlJs({ locateFile: (f) => `vendor/${f}` });
  estado.db = await Database.open({ SQL, storage: createIdbStorage() });
  estado.app = createServices(estado.db);
  estado.refrescar = render;

  registrarServiceWorker();
  solicitarPersistencia().then((ok) => { estado.persistente = ok; }).catch(() => { estado.persistente = false; });

  $arranque.remove();
  $fab.addEventListener('click', () => abrirFormularioMovimiento());
  window.addEventListener('hashchange', render);
  render();
}

function render() {
  const bienvenidaHecha = estado.app.ajustes.get('bienvenida') === 'hecha';
  if (!bienvenidaHecha) {
    $tabs.hidden = true;
    $fab.hidden = true;
    vaciar($vista, vistaBienvenida(() => { location.hash = '#/inicio'; render(); }));
    return;
  }

  const [nombre = 'inicio', ...params] = location.hash.replace(/^#\/?/, '').split('/');
  const vista = RUTAS[nombre] ?? vistaInicio;
  $tabs.hidden = false;
  $fab.hidden = false;
  for (const a of $tabs.querySelectorAll('a')) {
    a.classList.toggle('activa', a.dataset.ruta === nombre || (nombre === 'plan' && a.dataset.ruta === 'metas'));
  }

  try {
    vaciar($vista, vista(params));
  } catch (err) {
    console.error(err);
    vaciar($vista, h('div', { class: 'banner error' }, `No se pudo mostrar esta pantalla: ${err.message}`));
  }
}

function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (location.protocol !== 'https:' && !local) return;
  const habiaControlador = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker no registrado:', err));
  // Versión nueva instalada: no se recarga sola para no perder un formulario a medias.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (habiaControlador) toast('Hay una versión nueva. Cierra y vuelve a abrir la app para usarla.', 'info', 6000);
  });
}

arrancar().catch((err) => {
  console.error(err);
  vaciar($arranque,
    h('div', {},
      h('h3', {}, 'No se pudo abrir la app'),
      h('p', { class: 'muted' }, err.message),
      h('button', { class: 'btn', onclick: () => location.reload() }, 'Reintentar')));
});
