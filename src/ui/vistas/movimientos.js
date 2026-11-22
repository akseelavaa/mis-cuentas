// Movimientos del mes con filtros por tipo, categoría y texto.
import { estado } from '../estado.js';
import { h, vaciar, select, vacio } from '../dom.js';
import { euros, selectorMes, filaMovimiento, etiquetaDia } from '../piezas.js';
import { rangoMes } from '../../domain/dates.js';

const TIPOS = [[null, 'Todos'], [['gasto'], 'Gastos'], [['ingreso'], 'Ingresos'], [['ahorro_aporte', 'ahorro_retiro'], 'Ahorro']];
const filtros = { tipo: null, categoria_id: '', texto: '', limite: 100 };

export function vistaMovimientos() {
  const { app } = estado;
  const cambiarMes = (m) => { estado.mes = m; filtros.limite = 100; estado.refrescar(); };
  const resumen = app.analitica.resumenMensual(estado.mes);
  const $lista = h('div');

  const pintarLista = () => {
    const { desde, hasta } = rangoMes(estado.mes);
    const { items, total } = app.movimientos.listar(filtrosConsulta(desde, hasta));
    if (!items.length) {
      vaciar($lista, vacio('🧾', filtros.texto || filtros.tipo || filtros.categoria_id
        ? 'No hay movimientos con esos filtros.' : 'No hay movimientos este mes.'));
      return;
    }
    const grupos = [];
    for (const m of items) {
      if (grupos.at(-1)?.fecha !== m.fecha) grupos.push({ fecha: m.fecha, items: [] });
      grupos.at(-1).items.push(m);
    }
    vaciar($lista,
      h('div', { class: 'lista' }, grupos.map((g) => [
        h('div', { class: 'dia' }, etiquetaDia(g.fecha)),
        g.items.map((m) => filaMovimiento(m)),
      ])),
      items.length < total && filtros.limite < 500
        ? h('button', { class: 'btn sec bloque', onclick: () => { filtros.limite += 100; pintarLista(); } },
          `Ver más (${total - items.length})`)
        : null);
  };

  const categorias = app.categorias.listar({ incluirInactivas: true });
  const buscador = h('input', {
    type: 'search', placeholder: 'Buscar en notas…', value: filtros.texto, enterkeyhint: 'search',
    oninput: debounce((e) => { filtros.texto = e.target.value; pintarLista(); }, 250),
  });

  const vista = [
    h('h1', {}, 'Movimientos'),
    selectorMes(estado.mes, cambiarMes),
    h('div', { class: 'card entre small' },
      h('div', {}, h('div', { class: 'muted' }, 'Ingresos'), h('strong', { class: 'num ok' }, euros(resumen.ingresos_cent))),
      h('div', {}, h('div', { class: 'muted' }, 'Gastos'), h('strong', { class: 'num' }, euros(resumen.gastos_cent))),
      h('div', {}, h('div', { class: 'muted' }, 'Apartado'), h('strong', { class: 'num' }, euros(resumen.aportado_metas_cent - resumen.retirado_metas_cent)))),
    h('div', { class: 'chips' }, TIPOS.map(([t, texto]) => h('button', {
      type: 'button',
      class: JSON.stringify(filtros.tipo) === JSON.stringify(t) ? 'activo' : '',
      onclick: () => { filtros.tipo = t; filtros.categoria_id = ''; estado.refrescar(); },
    }, texto))),
    h('div', { class: 'fila', style: { marginBottom: '12px' } },
      h('label', { class: 'campo crece', style: { margin: 0 } }, buscador),
      h('label', { class: 'campo', style: { margin: 0, width: '45%' } },
        select('categoria_id', [['', 'Todas las categorías'],
          ...categorias.filter((c) => !filtros.tipo || filtros.tipo.includes(c.tipo)).map((c) => [c.id, `${c.icono ?? ''} ${c.nombre}`])],
        filtros.categoria_id, { onchange: (e) => { filtros.categoria_id = e.target.value; pintarLista(); } }))),
    $lista,
  ];
  pintarLista();
  return vista;
}

function filtrosConsulta(desde, hastaExclusivo) {
  // listar() usa «hasta» inclusivo: el último día del mes es el anterior al 1 del siguiente.
  const [y, m] = hastaExclusivo.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  return {
    desde,
    hasta: ultimo,
    tipo: filtros.tipo ?? undefined,
    categoria_id: filtros.categoria_id || undefined,
    texto: filtros.texto || undefined,
    limite: Math.min(500, filtros.limite),
  };
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
