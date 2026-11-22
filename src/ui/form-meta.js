// Crear / editar una meta de ahorro.
import { estado } from './estado.js';
import {
  h, abrirHoja, campo, input, inputImporte, select, alEnviar, toast, confirmar, mostrarError,
} from './dom.js';
import { centsToInput } from '../domain/money.js';

const PRIORIDADES = [[1, '1 · La más importante'], [2, '2'], [3, '3 · Normal'], [4, '4'], [5, '5 · Cuando se pueda']];

export function abrirFormularioMeta(meta = null) {
  const { app } = estado;
  const editando = !!meta;

  return abrirHoja(editando ? meta.nombre : 'Nueva meta', (cerrar) => {
    const form = h('form', { novalidate: true, autocomplete: 'off' },
      campo('¿Para qué ahorras?', input('nombre', { valor: meta?.nombre, placeholder: 'iPhone', maxlength: 60, autofocus: !editando })),
      campo('¿Cuánto necesitas? (€)', inputImporte('objetivo', meta ? centsToInput(meta.objetivo_cent) : '')),
      campo('¿Para cuándo? (opcional)', input('fecha_limite', { tipo: 'date', valor: meta?.fecha_limite })),
      h('p', { class: 'muted small', style: { margin: '-8px 4px 14px' } },
        'Con fecha, la app calcula cuánto apartar cada mes. Sin fecha, puedes fijar una cuota mensual.'),
      campo('Cuota mensual fija (opcional, sin fecha)', inputImporte('aporte_mensual',
        meta?.aporte_mensual_cent ? centsToInput(meta.aporte_mensual_cent) : '')),
      campo('Prioridad', select('prioridad', PRIORIDADES, meta?.prioridad ?? 3)),
      editando ? null : campo('¿Ya tienes algo ahorrado para esto? (€, opcional)', inputImporte('saldo_inicial', '')),
      h('button', { class: 'btn bloque', type: 'submit' }, editando ? 'Guardar cambios' : 'Crear meta'),
      editando ? accionesEstado(meta, cerrar) : null,
    );

    alEnviar(form, async (fd) => {
      const datos = Object.fromEntries(['nombre', 'objetivo', 'fecha_limite', 'aporte_mensual', 'prioridad', 'saldo_inicial']
        .filter((k) => fd.has(k)).map((k) => [k, fd.get(k)]));
      const r = editando ? await app.metas.editar(meta.id, datos) : await app.metas.crear(datos);
      cerrar(r);
      toast(editando ? 'Meta actualizada' : `Meta «${r.nombre}» creada`);
      estado.refrescar();
    });
    return form;
  });
}

function accionesEstado(meta, cerrar) {
  const { app } = estado;
  const accion = (texto, fn, clase = 'sec') => h('button', {
    class: `btn ${clase} peq`, type: 'button',
    onclick: async () => {
      try { await fn(); cerrar(true); estado.refrescar(); } catch (err) { mostrarError(err); }
    },
  }, texto);

  return h('div', { class: 'botones', style: { marginTop: '20px' } },
    meta.estado === 'activa'
      ? accion('Marcar como conseguida', async () => {
        await app.metas.cambiarEstado(meta.id, 'completada');
        toast(`¡Enhorabuena por «${meta.nombre}»! 🎉`);
      })
      : accion('Reactivar', () => app.metas.cambiarEstado(meta.id, 'activa')),
    meta.estado !== 'archivada' ? accion('Archivar', async () => {
      if (!await confirmar(`¿Archivar «${meta.nombre}»? Dejará de aparecer en el plan.`, { aceptar: 'Archivar' })) throw cancelado();
      await app.metas.cambiarEstado(meta.id, 'archivada');
    }) : null,
    accion('Eliminar', async () => {
      if (!await confirmar(`¿Eliminar «${meta.nombre}»? Solo es posible si no tiene movimientos.`)) throw cancelado();
      await app.metas.eliminar(meta.id);
      toast('Meta eliminada');
    }, 'peligro'),
  );
}

// Cancelar una confirmación no es un error que mostrar: se lanza un AppError silencioso.
function cancelado() {
  const e = new Error('cancelado');
  e.silencioso = true;
  return e;
}
