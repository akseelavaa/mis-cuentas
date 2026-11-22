// Ajustes: cuentas, categorías, ingresos previstos y gastos fijos, plan y datos.
import { estado } from '../estado.js';
import { h, select, toast, mostrarError } from '../dom.js';
import { euros, estadoInstalacion } from '../piezas.js';
import { abrirFormularioCuenta, abrirFormularioCategoria, abrirFormularioPrevision } from '../form-ajustes.js';
import { hacerCopia, restaurarCopia, exportarCSV, importarCSV } from '../copias.js';
import { formatFecha } from '../../domain/dates.js';

export function vistaAjustes() {
  const { app } = estado;
  const defecto = Number(app.ajustes.get('cuenta_por_defecto'));
  const saldos = new Map(app.saldos.porCuenta().map((c) => [c.id, c.saldo_cent]));
  const fila = (icono, texto, derecha, onclick, apagada = false) => h('button', { type: 'button', onclick, style: { opacity: apagada ? 0.5 : 1 } },
    h('span', { class: 'icono' }, icono), h('span', { class: 'trunc', style: { flex: 1 } }, texto),
    derecha !== null ? h('span', { class: 'num muted small' }, derecha) : null, h('span', { class: 'muted' }, '›'));
  const anadir = (texto, onclick) => h('button', { type: 'button', onclick, style: { color: 'var(--accent)' } },
    h('span', { class: 'icono' }, '＋'), texto);

  const cuentas = app.cuentas.listar({ incluirInactivas: true });
  const categorias = app.categorias.listar({ incluirInactivas: true });
  const previsiones = app.previsiones.listar({ incluirInactivas: true });
  const inst = estadoInstalacion();

  return [
    h('h1', {}, 'Ajustes'),

    h('h2', {}, 'Ingresos previstos'),
    h('div', { class: 'lista' },
      previsiones.filter((p) => p.tipo === 'ingreso').map((p) => fila(p.icono ?? '💼', p.nombre, euros(p.importe_cent), () => abrirFormularioPrevision(p))),
      anadir('Añadir ingreso previsto', () => abrirFormularioPrevision({ tipo: 'ingreso' }))),
    h('h2', {}, 'Gastos fijos mensuales'),
    h('div', { class: 'lista' },
      previsiones.filter((p) => p.tipo === 'gasto').map((p) => fila(p.icono ?? '•', `${p.nombre}${p.dia_mes ? ` · día ${p.dia_mes}` : ''}`, euros(p.importe_cent), () => abrirFormularioPrevision(p))),
      anadir('Añadir gasto fijo (alquiler, Netflix…)', () => abrirFormularioPrevision({ tipo: 'gasto' }))),

    h('h2', {}, 'Cuentas'),
    h('div', { class: 'lista' },
      cuentas.map((c) => fila(c.tipo === 'efectivo' ? '💶' : c.tipo === 'tarjeta' ? '💳' : '🏦',
        `${c.nombre}${c.id === defecto ? ' (por defecto)' : ''}`, euros(saldos.get(c.id) ?? 0), () => abrirFormularioCuenta(c), !c.activa)),
      anadir('Añadir cuenta', () => abrirFormularioCuenta())),

    ['gasto', 'ingreso'].map((tipo) => [
      h('h2', {}, tipo === 'gasto' ? 'Categorías de gasto' : 'Categorías de ingreso'),
      h('div', { class: 'lista' },
        categorias.filter((c) => c.tipo === tipo).map((c) => fila(c.icono ?? '•', c.nombre,
          tipo === 'gasto' ? (c.recortable ? 'recortable' : 'necesaria') : null, () => abrirFormularioCategoria(c), !c.activa)),
        anadir('Añadir categoría', () => abrirFormularioCategoria(null, tipo))),
    ]),

    h('h2', {}, 'Cómo calcular el plan'),
    h('div', { class: 'card' },
      h('label', { class: 'campo' }, h('span', {}, 'Ingresos estimados a partir de'),
        select('estrategia', [['minimo', 'El mes más flojo (prudente)'], ['media', 'La media']], app.ajustes.get('estrategia_ingresos'), {
          onchange: (e) => guardar('estrategia_ingresos', e.target.value),
        })),
      h('label', { class: 'campo', style: { marginBottom: 0 } }, h('span', {}, 'Meses de historial'),
        select('meses', [1, 2, 3, 4, 6, 12].map((n) => [n, `${n} ${n === 1 ? 'mes' : 'meses'}`]), app.ajustes.get('meses_historial'), {
          onchange: (e) => guardar('meses_historial', e.target.value),
        }))),

    h('h2', {}, 'Tus datos'),
    h('div', { class: 'card small' },
      h('p', {}, '🔒 Tus datos solo están en este teléfono. No se envían a ningún servidor.'),
      h('p', { class: inst.instalada ? 'ok' : 'warn' }, inst.instalada
        ? '✓ App instalada en la pantalla de inicio.'
        : '⚠︎ Ábrela desde la pantalla de inicio (Compartir → Añadir a pantalla de inicio) para que Safari no borre tus datos.'),
      h('p', { class: inst.persistente ? 'ok' : 'muted' }, inst.persistente
        ? '✓ Almacenamiento persistente concedido.'
        : 'Almacenamiento persistente: no confirmado por el navegador.'),
    ),
    h('h2', {}, 'Copias de seguridad'),
    h('div', { class: 'lista' },
      fila('💾', 'Guardar copia de seguridad', textoUltimaCopia(app.respaldo.estadoRespaldo()), hacerCopia),
      fila('♻️', 'Restaurar una copia…', null, restaurarCopia)),
    h('p', { class: 'small muted', style: { margin: '-4px 4px 12px' } },
      'La copia (.json) contiene todo. Guárdala en Archivos o iCloud Drive: si cambias de móvil o borras la app, la restauras aquí.'),
    h('h2', {}, 'Excel / CSV'),
    h('div', { class: 'lista' },
      fila('📤', 'Exportar movimientos (CSV)', null, exportarCSV),
      fila('📥', 'Importar movimientos desde CSV…', null, importarCSV)),
    h('p', { class: 'small muted', style: { margin: '-4px 4px 12px' } },
      'Importar añade movimientos sin borrar nada y omite los que ya tienes. Sirve también para extractos del banco (fecha, concepto, importe con signo).'),
    h('p', { class: 'small muted', style: { textAlign: 'center', marginTop: '16px' } }, `Esquema de datos v${estado.db.schemaVersion}`),
  ];
}

function textoUltimaCopia(e) {
  if (!e.ultimo) return 'nunca';
  if (e.dias === 0) return 'hoy';
  if (e.dias === 1) return 'ayer';
  return e.dias < 30 ? `hace ${e.dias} días` : formatFecha(e.ultimo.slice(0, 10));
}

async function guardar(clave, valor) {
  try {
    await estado.app.ajustes.set(clave, valor);
    toast('Guardado', 'info', 1500);
    estado.refrescar();
  } catch (err) { mostrarError(err); }
}
