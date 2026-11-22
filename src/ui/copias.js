// Flujos de copia de seguridad, restauración y CSV (usados desde Ajustes e Inicio).
import { estado } from './estado.js';
import { h, abrirHoja, toast, mostrarError } from './dom.js';
import { guardarArchivo, elegirArchivo } from './archivos.js';
import { formatFecha } from '../domain/dates.js';

export async function hacerCopia() {
  const { app } = estado;
  try {
    const archivo = await app.respaldo.exportarJSON({ marcar: false });
    if (await guardarArchivo(archivo)) {
      await app.respaldo.marcarRespaldo();
      toast('Copia de seguridad guardada ✓');
      estado.refrescar();
    }
  } catch (err) { mostrarError(err); }
}

export async function restaurarCopia() {
  const { app } = estado;
  const f = await elegirArchivo('.json,application/json');
  if (!f) return;
  let resumen;
  try { resumen = app.respaldo.resumenJSON(f.texto); } catch (err) { mostrarError(err); return; }

  await abrirHoja('Restaurar copia', (cerrar) => h('div', {},
    h('p', {}, `Copia «${f.nombre}»`, resumen.exportado_en ? ` del ${formatFecha(resumen.exportado_en.slice(0, 10))}` : '', ':'),
    h('div', { class: 'lista' },
      fila('Movimientos', resumen.movimientos), fila('Metas', resumen.metas),
      fila('Categorías', resumen.categorias), fila('Cuentas', resumen.cuentas)),
    h('div', { class: 'banner aviso' },
      h('strong', {}, 'Se reemplazarán todos tus datos actuales'),
      resumen.actuales.movimientos ? ` (${resumen.actuales.movimientos} movimientos).` : '.',
      ' Si algo falla, no se cambia nada.'),
    resumen.actuales.movimientos ? h('button', { class: 'btn sec bloque', type: 'button', onclick: hacerCopia },
      'Guardar antes una copia de lo actual') : null,
    h('button', {
      class: 'btn bloque', type: 'button', style: { marginTop: '8px' },
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          await app.respaldo.restaurarJSON(f.texto);
          cerrar(true);
          toast('Copia restaurada ✓');
          location.hash = '#/inicio';
          estado.refrescar();
        } catch (err) { mostrarError(err); e.target.disabled = false; }
      },
    }, 'Restaurar'),
  ));
}

export async function exportarCSV() {
  try {
    const archivo = estado.app.respaldo.exportarCSV();
    if (archivo.filas === 0) { toast('No hay movimientos que exportar.'); return; }
    await guardarArchivo(archivo);
  } catch (err) { mostrarError(err); }
}

export async function importarCSV() {
  const { app } = estado;
  const f = await elegirArchivo('.csv,text/csv,text/plain');
  if (!f) return;

  let previa;
  try {
    previa = await app.respaldo.importarCSV(f.texto, { simular: true });
  } catch (err) {
    if (err.detalles) { mostrarErroresCSV(f.nombre, err); return; }
    mostrarError(err);
    return;
  }

  await abrirHoja('Importar movimientos', (cerrar) => h('div', {},
    h('p', {}, `Fichero «${f.nombre}»:`),
    h('div', { class: 'lista' },
      fila('Movimientos a añadir', previa.importados),
      previa.duplicados ? fila('Ya los tenías (se omiten)', previa.duplicados) : null,
      previa.categorias_nuevas.length ? h('div', { style: { display: 'block' } },
        h('div', {}, `Categorías nuevas: ${previa.categorias_nuevas.length}`),
        h('div', { class: 'small muted' }, previa.categorias_nuevas.join(', '))) : null),
    h('p', { class: 'small muted' }, 'Se añaden a lo que ya tienes; no se borra nada.'),
    previa.importados === 0
      ? h('p', {}, 'No hay nada nuevo que importar.')
      : h('button', {
        class: 'btn bloque', type: 'button',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const r = await app.respaldo.importarCSV(f.texto);
            cerrar(true);
            toast(`${r.importados} movimientos importados ✓`);
            estado.refrescar();
          } catch (err) { mostrarError(err); e.target.disabled = false; }
        },
      }, `Importar ${previa.importados} movimientos`),
  ));
}

function mostrarErroresCSV(nombre, err) {
  return abrirHoja('No se puede importar', () => h('div', {},
    h('div', { class: 'banner error' }, err.message),
    h('p', { class: 'small muted' }, `Corrige estas líneas de «${nombre}» y vuelve a intentarlo:`),
    h('div', { class: 'lista' }, err.detalles.map((d) => h('div', { class: 'small', style: { alignItems: 'flex-start' } },
      h('strong', { style: { minWidth: '64px' } }, `Línea ${d.linea}`), h('span', {}, d.mensaje)))),
    h('p', { class: 'small muted' },
      'Columnas que entiendo: fecha, importe (obligatorias), tipo (gasto/ingreso/aporte/retiro), categoria, meta, cuenta, nota. '
      + 'Sin «tipo», un importe negativo es un gasto.')));
}

function fila(texto, valor) {
  return h('div', {}, h('span', { style: { flex: 1 } }, texto), h('strong', { class: 'num' }, String(valor)));
}

/** Banner para Inicio si toca hacer copia. */
export function bannerCopia() {
  const e = estado.app.respaldo.estadoRespaldo();
  if (!e.recordar) return null;
  return h('div', { class: 'banner info' },
    h('strong', {}, '💾 ', e.dias === null ? 'Aún no has hecho ninguna copia de seguridad.' : `Tu última copia es de hace ${e.dias} días.`),
    ' Tus datos solo están en este teléfono: guarda una copia en Archivos o iCloud.',
    h('div', { class: 'botones', style: { marginTop: '8px' } },
      h('button', { class: 'btn peq', type: 'button', onclick: hacerCopia }, 'Hacer copia ahora')));
}

