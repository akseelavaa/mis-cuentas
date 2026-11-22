// Primera apertura: lo mínimo para que el plan funcione desde el primer día.
import { estado } from '../estado.js';
import { h, campo, inputImporte, input, alEnviar, toast, mostrarError } from '../dom.js';
import { bannerInstalar } from '../piezas.js';
import { AppError } from '../../errors.js';
import { restaurarCopia } from '../copias.js';

export function vistaBienvenida(alTerminar) {
  const { app } = estado;
  const principal = app.cuentas.listar()[0];

  // Los campos llevan prefijo para no chocar entre servicios; los errores se remapean.
  const conPrefijo = async (prefijo, fn) => {
    try { return await fn(); } catch (err) {
      if (err instanceof AppError && err.field) err.field = `${prefijo}${err.field}`;
      throw err;
    }
  };

  const form = h('form', { novalidate: true, autocomplete: 'off' },
    h('h2', {}, '1 · ¿Cuánto tienes ahora?'),
    campo('Dinero en tu cuenta hoy (€)', inputImporte('cuenta_saldo_inicial', '', { inputmode: 'text' })),
    h('p', { class: 'muted small', style: { margin: '-8px 4px 14px' } }, 'Es tu punto de partida. Puedes añadir más cuentas (efectivo, tarjeta) en Ajustes.'),

    h('h2', {}, '2 · ¿Cuánto entra y cuánto es fijo?'),
    campo('Ingreso aproximado (€)', inputImporte('ingreso_importe', '')),
    h('p', { class: 'muted small', style: { margin: '-8px 4px 14px' } },
      'Si varía, pon lo de un mes flojo. Cuando tengas 3 meses apuntados usaré tus ingresos reales.'),

    campo('Gastos fijos al mes: alquiler, facturas, seguros… (€)', inputImporte('fijos_importe', '')),
    h('p', { class: 'muted small', style: { margin: '-8px 4px 14px' } },
      'Lo que pagas sí o sí cada mes. Luego puedes detallarlo en Ajustes.'),

    h('h2', {}, '3 · ¿Para qué ahorras? (opcional)'),
    campo('Meta', input('meta_nombre', { placeholder: 'iPhone', maxlength: 60 })),
    h('div', { class: 'fila' },
      h('div', { class: 'crece' }, campo('Cuánto (€)', inputImporte('meta_objetivo', ''))),
      h('div', { class: 'crece' }, campo('Para cuándo', input('meta_fecha_limite', { tipo: 'date' })))),
    campo('Ya tengo ahorrado para esto (€)', inputImporte('meta_saldo_inicial', '')),

    h('button', { class: 'btn bloque', type: 'submit' }, 'Empezar'),
    h('button', {
      class: 'enlace', type: 'button', style: { display: 'block', margin: '12px auto' },
      onclick: async () => { try { await app.ajustes.set('bienvenida', 'hecha'); alTerminar(); } catch (err) { mostrarError(err); } },
    }, 'Saltar por ahora'),
  );

  alEnviar(form, async (fd) => {
    const val = (k) => String(fd.get(k) ?? '').trim();
    if (val('cuenta_saldo_inicial')) {
      await conPrefijo('cuenta_', () => app.cuentas.editar(principal.id, { saldo_inicial: val('cuenta_saldo_inicial') }));
    }
    if (val('ingreso_importe') && !app.previsiones.listar({ tipo: 'ingreso' }).length) {
      const nomina = app.categorias.listar({ tipo: 'ingreso' })[0];
      await conPrefijo('ingreso_', () => app.previsiones.crear({
        nombre: 'Sueldo aproximado', tipo: 'ingreso', categoria_id: nomina.id, importe: val('ingreso_importe'),
      }));
    }
    if (val('fijos_importe') && !app.previsiones.listar({ tipo: 'gasto' }).length) {
      const gastos = app.categorias.listar({ tipo: 'gasto' });
      const vivienda = gastos.find((c) => c.nombre === 'Vivienda') ?? gastos.find((c) => !c.recortable) ?? gastos[0];
      await conPrefijo('fijos_', () => app.previsiones.crear({
        nombre: 'Gastos fijos', tipo: 'gasto', categoria_id: vivienda.id, importe: val('fijos_importe'),
      }));
    }
    if (val('meta_nombre') || val('meta_objetivo')) {
      await conPrefijo('meta_', () => app.metas.crear({
        nombre: val('meta_nombre'), objetivo: val('meta_objetivo'), fecha_limite: val('meta_fecha_limite'),
        saldo_inicial: val('meta_saldo_inicial'), prioridad: 1,
      }));
    }
    await app.ajustes.set('bienvenida', 'hecha');
    toast('¡Listo! Apunta tus gastos con el botón ＋', 'info', 4000);
    alTerminar();
  });

  return [
    h('h1', {}, 'Mis cuentas'),
    h('p', {}, 'Apunta lo que gastas y te diré cuánto puedes gastar en cada cosa sin dejar de ahorrar para lo que quieres.'),
    h('p', { class: 'muted small' }, '🔒 Todo se guarda solo en este teléfono.'),
    bannerInstalar(),
    h('div', { class: 'card fila' },
      h('span', { class: 'crece' }, '¿Ya usabas la app y tienes una copia de seguridad?'),
      h('button', { class: 'btn sec peq', type: 'button', onclick: restaurarCopia }, 'Restaurar')),
    form,
  ];
}
