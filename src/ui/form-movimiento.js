// Hoja para apuntar o editar un movimiento. Pensada para el pulgar: importe grande,
// categorías como botones, fecha de hoy por defecto. Apuntar un gasto = 3 toques.
import { estado } from './estado.js';
import {
  h, vaciar, abrirHoja, campo, input, inputImporte, select, alEnviar, toast, mostrarAvisos, confirmar, mostrarError, vacio,
} from './dom.js';
import { centsToInput, formatImporte } from '../domain/money.js';
import { hoy } from '../domain/dates.js';
import { abrirFormularioMeta } from './form-meta.js';

const FAMILIAS = [['gasto', 'Gasto'], ['ingreso', 'Ingreso'], ['ahorro', 'Ahorro']];

export function abrirFormularioMovimiento({ movimiento = null, tipo = 'gasto', metaId = null } = {}) {
  const { app } = estado;
  const editando = !!movimiento;
  const s = {
    tipo: movimiento?.tipo ?? tipo,
    importe: movimiento ? centsToInput(movimiento.importe_cent) : '',
    fecha: movimiento?.fecha ?? hoy(),
    nota: movimiento?.nota ?? '',
    categoria_id: movimiento?.categoria_id ?? null,
    meta_id: movimiento?.meta_id ?? metaId,
    cuenta_id: movimiento?.cuenta_id ?? Number(app.ajustes.get('cuenta_por_defecto')),
  };
  const familia = () => (s.tipo.startsWith('ahorro') ? 'ahorro' : s.tipo);
  const titulo = editando ? 'Editar movimiento' : 'Apuntar';

  return abrirHoja(titulo, (cerrar) => {
    const form = h('form', { novalidate: true, autocomplete: 'off' });
    const guardarValores = () => {
      const fd = new FormData(form);
      for (const k of ['importe', 'fecha', 'nota', 'cuenta_id', 'meta_id']) if (fd.has(k)) s[k] = fd.get(k);
    };

    function pintar() {
      vaciar(form,
        h('div', { class: 'segmentado', role: 'tablist' }, FAMILIAS.map(([f, texto]) => h('button', {
          type: 'button',
          class: familia() === f ? 'activo' : '',
          onclick: () => {
            guardarValores();
            if (familia() === f) return;
            s.tipo = f === 'ahorro' ? 'ahorro_aporte' : f;
            s.categoria_id = null;
            pintar();
          },
        }, texto))),
        campo('Importe (€)', inputImporte('importe', s.importe, { autofocus: !editando, required: true }), { clase: 'importe-grande' }),
        familia() === 'ahorro' ? parteAhorro() : parteCategoria(),
        campo('Fecha', input('fecha', { tipo: 'date', valor: s.fecha, required: true })),
        familia() !== 'ahorro' ? selectorCuenta() : null,
        campo('Nota (opcional)', h('textarea', { name: 'nota', maxlength: 500, rows: 2 }, s.nota ?? '')),
        h('button', { class: 'btn bloque', type: 'submit' }, editando ? 'Guardar cambios' : 'Guardar'),
        editando ? h('button', {
          class: 'btn peligro bloque', type: 'button', style: { marginTop: '8px' },
          onclick: async () => {
            if (!await confirmar('¿Eliminar este movimiento? No se puede deshacer.')) return;
            try {
              await app.movimientos.eliminar(movimiento.id);
              toast('Movimiento eliminado');
              cerrar(true);
              estado.refrescar();
            } catch (err) { mostrarError(err); }
          },
        }, 'Eliminar movimiento') : null,
      );
    }

    function parteCategoria() {
      const cats = app.categorias.listar({ tipo: s.tipo, incluirInactivas: true })
        .filter((c) => c.activa || c.id === s.categoria_id);
      const rejilla = h('div', { class: 'rejilla-cat', dataset: { campo: 'categoria_id' } },
        cats.map((c) => h('button', {
          type: 'button',
          class: c.id === s.categoria_id ? 'activo' : '',
          'aria-pressed': c.id === s.categoria_id ? 'true' : 'false',
          onclick: () => { guardarValores(); s.categoria_id = c.id; pintar(); },
        }, h('span', {}, c.icono || '•'), c.nombre)));
      return [h('span', { class: 'muted small', style: { margin: '0 4px 6px', display: 'block' } }, 'Categoría'), rejilla];
    }

    function parteAhorro() {
      const metas = app.metas.listar().filter((m) => (s.tipo === 'ahorro_aporte'
        ? m.estado === 'activa' || m.id === s.meta_id
        : m.saldo_cent > 0 || m.id === s.meta_id));
      const sub = h('div', { class: 'segmentado' },
        [['ahorro_aporte', 'Apartar'], ['ahorro_retiro', 'Retirar']].map(([t, texto]) => h('button', {
          type: 'button',
          class: s.tipo === t ? 'activo' : '',
          onclick: () => { guardarValores(); s.tipo = t; pintar(); },
        }, texto)));
      if (metas.length === 0) {
        return [sub, vacio('🎯', s.tipo === 'ahorro_aporte' ? 'Aún no tienes metas de ahorro.' : 'Ninguna meta tiene saldo.',
          s.tipo === 'ahorro_aporte' ? h('button', {
            class: 'btn sec', type: 'button', onclick: async () => { await abrirFormularioMeta(); pintar(); },
          }, 'Crear una meta') : null)];
      }
      if (!metas.some((m) => m.id === Number(s.meta_id))) s.meta_id = metas[0].id;
      const disp = app.saldos.calcular().disponible_cent;
      return [
        sub,
        campo('Meta', select('meta_id', metas.map((m) => [m.id, `${m.nombre} · ${formatImporte(m.saldo_cent)}`]), s.meta_id)),
        h('p', { class: 'muted small', style: { margin: '-6px 4px 14px' } }, s.tipo === 'ahorro_aporte'
          ? `Disponible para apartar: ${formatImporte(Math.max(0, disp))}`
          : 'El dinero vuelve a tu disponible para gastar.'),
      ];
    }

    function selectorCuenta() {
      const cuentas = app.cuentas.listar({ incluirInactivas: true })
        .filter((c) => c.activa || c.id === Number(s.cuenta_id));
      if (cuentas.length <= 1) return h('input', { type: 'hidden', name: 'cuenta_id', value: cuentas[0]?.id ?? '' });
      return campo('Cuenta', select('cuenta_id', cuentas.map((c) => [c.id, c.nombre]), s.cuenta_id));
    }

    alEnviar(form, async (fd) => {
      const datos = {
        tipo: s.tipo,
        importe: fd.get('importe'),
        fecha: fd.get('fecha'),
        nota: fd.get('nota'),
        categoria_id: familia() === 'ahorro' ? null : s.categoria_id,
        meta_id: familia() === 'ahorro' ? fd.get('meta_id') : null,
        cuenta_id: familia() === 'ahorro' ? null : fd.get('cuenta_id'),
      };
      const r = editando
        ? await app.movimientos.editar(movimiento.id, datos)
        : await app.movimientos.crear(datos);
      cerrar(r.movimiento);
      toast(editando ? 'Cambios guardados' : `${etiqueta(r.movimiento)} guardado`, 'info', 2000);
      mostrarAvisos(r.avisos);
      estado.refrescar();
    });

    pintar();
    return form;
  });
}

function etiqueta(m) {
  return {
    gasto: `Gasto de ${formatImporte(m.importe_cent)}`,
    ingreso: `Ingreso de ${formatImporte(m.importe_cent)}`,
    ahorro_aporte: `Aporte a ${m.meta}`,
    ahorro_retiro: `Retiro de ${m.meta}`,
  }[m.tipo];
}
