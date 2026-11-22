// Formularios de Ajustes: cuentas, categorías y previsiones (gastos fijos / ingresos previstos).
import { estado } from './estado.js';
import {
  h, abrirHoja, campo, campoCheck, input, inputImporte, select, alEnviar, toast, confirmar, mostrarError,
} from './dom.js';
import { centsToInput } from '../domain/money.js';

function botonEliminar(texto, pregunta, fn, cerrar) {
  return h('button', {
    class: 'btn peligro bloque', type: 'button', style: { marginTop: '8px' },
    onclick: async () => {
      if (!await confirmar(pregunta)) return;
      try { await fn(); toast('Eliminado'); cerrar(true); estado.refrescar(); } catch (err) { mostrarError(err); }
    },
  }, texto);
}

function botonArchivar(activa, fn, cerrar) {
  return h('button', {
    class: 'btn sec bloque', type: 'button', style: { marginTop: '8px' },
    onclick: async () => {
      try { await fn(!activa); toast(activa ? 'Archivada' : 'Reactivada'); cerrar(true); estado.refrescar(); } catch (err) { mostrarError(err); }
    },
  }, activa ? 'Archivar (ocultar sin borrar)' : 'Reactivar');
}

// ------------------------------------------------------------------ cuentas

export function abrirFormularioCuenta(cuenta = null) {
  const { app } = estado;
  return abrirHoja(cuenta ? cuenta.nombre : 'Nueva cuenta', (cerrar) => {
    const esDefecto = cuenta && Number(app.ajustes.get('cuenta_por_defecto')) === cuenta.id;
    const form = h('form', { novalidate: true },
      campo('Nombre', input('nombre', { valor: cuenta?.nombre, maxlength: 60, placeholder: 'Efectivo' })),
      campo('Tipo', select('tipo', [['banco', 'Banco'], ['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['otro', 'Otro']], cuenta?.tipo ?? 'banco')),
      campo('Saldo al empezar a usar la app (€)', inputImporte('saldo_inicial',
        cuenta ? centsToInput(cuenta.saldo_inicial_cent) : '', { inputmode: 'text' })),
      h('p', { class: 'muted small', style: { margin: '-8px 4px 14px' } },
        'Lo que había en la cuenta antes de tu primer movimiento. Puede ser negativo (deuda de tarjeta): «-120,50».'),
      cuenta && !esDefecto ? campoCheck('Usar como cuenta por defecto', 'defecto', false) : null,
      h('button', { class: 'btn bloque', type: 'submit' }, cuenta ? 'Guardar' : 'Crear cuenta'),
      cuenta ? botonArchivar(!!cuenta.activa, (a) => app.cuentas.activar(cuenta.id, a), cerrar) : null,
      cuenta ? botonEliminar('Eliminar cuenta', `¿Eliminar «${cuenta.nombre}»? Solo es posible si no tiene movimientos.`,
        () => app.cuentas.eliminar(cuenta.id), cerrar) : null,
    );
    alEnviar(form, async (fd) => {
      const datos = { nombre: fd.get('nombre'), tipo: fd.get('tipo'), saldo_inicial: fd.get('saldo_inicial') || '0' };
      const r = cuenta ? await app.cuentas.editar(cuenta.id, datos) : await app.cuentas.crear(datos);
      if (fd.get('defecto')) await app.ajustes.set('cuenta_por_defecto', r.id);
      cerrar(r);
      toast('Cuenta guardada');
      estado.refrescar();
    });
    return form;
  });
}

// --------------------------------------------------------------- categorías

export function abrirFormularioCategoria(categoria = null, tipo = 'gasto') {
  const { app } = estado;
  const t = categoria?.tipo ?? tipo;
  return abrirHoja(categoria ? categoria.nombre : `Nueva categoría de ${t}`, (cerrar) => {
    const form = h('form', { novalidate: true },
      campo('Nombre', input('nombre', { valor: categoria?.nombre, maxlength: 60 })),
      campo('Icono (un emoji)', input('icono', { valor: categoria?.icono, maxlength: 8, placeholder: '🛒' })),
      t === 'gasto' ? campoCheck('Se puede recortar (ocio, caprichos…)', 'recortable', categoria ? categoria.recortable : true) : null,
      t === 'gasto' ? h('p', { class: 'muted small', style: { margin: '-8px 4px 14px' } },
        'El plan solo reduce las categorías recortables. Las demás (súper, alquiler…) se reservan enteras.') : null,
      h('button', { class: 'btn bloque', type: 'submit' }, categoria ? 'Guardar' : 'Crear'),
      categoria ? botonArchivar(!!categoria.activa, (a) => app.categorias.activar(categoria.id, a), cerrar) : null,
      categoria ? botonEliminar('Eliminar categoría', `¿Eliminar «${categoria.nombre}»? Solo es posible si no se ha usado.`,
        () => app.categorias.eliminar(categoria.id), cerrar) : null,
    );
    alEnviar(form, async (fd) => {
      const datos = { nombre: fd.get('nombre'), icono: fd.get('icono'), recortable: t === 'gasto' ? !!fd.get('recortable') : 0 };
      const r = categoria ? await app.categorias.editar(categoria.id, datos) : await app.categorias.crear({ ...datos, tipo: t });
      cerrar(r);
      toast('Categoría guardada');
      estado.refrescar();
    });
    return form;
  });
}

// ------------------------------------------------------------- previsiones

export function abrirFormularioPrevision(prevision = null) {
  const { app } = estado;
  const tipo = prevision?.tipo ?? 'gasto';
  const titulo = prevision?.id ? prevision.nombre : (tipo === 'ingreso' ? 'Ingreso previsto' : 'Gasto fijo');
  return abrirHoja(titulo, (cerrar) => {
    const cats = app.categorias.listar({ tipo });
    const form = h('form', { novalidate: true },
      h('p', { class: 'muted small' }, tipo === 'ingreso'
        ? 'Lo que esperas ganar al mes. Si varía, pon una cantidad prudente (la de un mes flojo). Cuando tengas 3 meses apuntados, el plan usará tus ingresos reales.'
        : 'Gastos que se repiten cada mes: alquiler, facturas, suscripciones… El plan los reserva antes de repartir el resto.'),
      campo('Nombre', input('nombre', { valor: prevision?.nombre ?? (tipo === 'ingreso' ? 'Sueldo aproximado' : ''), maxlength: 60 })),
      campo('Importe al mes (€)', inputImporte('importe', prevision?.importe_cent ? centsToInput(prevision.importe_cent) : '', { autofocus: !prevision?.id })),
      campo('Categoría', select('categoria_id', cats.map((c) => [c.id, `${c.icono ?? ''} ${c.nombre}`]),
        prevision?.categoria_id ?? cats[0]?.id)),
      campo('Día del mes (opcional)', input('dia_mes', { tipo: 'number', valor: prevision?.dia_mes, min: 1, max: 31, inputmode: 'numeric' })),
      h('button', { class: 'btn bloque', type: 'submit' }, 'Guardar'),
      prevision?.id ? botonEliminar('Eliminar', `¿Eliminar «${prevision.nombre}»?`, () => app.previsiones.eliminar(prevision.id), cerrar) : null,
    );
    alEnviar(form, async (fd) => {
      const datos = {
        tipo, nombre: fd.get('nombre'), importe: fd.get('importe'), categoria_id: fd.get('categoria_id'), dia_mes: fd.get('dia_mes'),
      };
      const r = prevision?.id ? await app.previsiones.editar(prevision.id, datos) : await app.previsiones.crear(datos);
      cerrar(r);
      toast('Guardado');
      estado.refrescar();
    });
    return form;
  });
}
