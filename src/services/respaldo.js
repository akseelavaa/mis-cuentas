// Copias de seguridad y portabilidad.
//
//  JSON  → copia COMPLETA (todas las tablas, ids incluidos). Restaurar REEMPLAZA todo,
//          en una sola transacción: si algo falla, tus datos actuales quedan intactos.
//  CSV   → solo movimientos, legible en Excel. Importar AÑADE movimientos (no borra),
//          con vista previa, detección de duplicados y creación de categorías nuevas.
import { ValidationError, AppError } from '../errors.js';
import { centsToInput, parseImporteConSigno } from '../domain/money.js';
import { parseFecha } from '../domain/dates.js';
import { aCSV, leerCSV, normalizarCabecera } from '../domain/csv.js';
import { LATEST_VERSION } from '../db/migrations.js';
import { clave } from './util.js';

export const FORMATO_JSON = 1;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ERRORES = 20;

// Orden de inserción: primero lo referenciado, después lo que referencia.
const TABLAS = ['cuentas', 'categorias', 'metas_ahorro', 'previsiones', 'presupuestos', 'movimientos', 'ajustes'];
const AJUSTES_CONOCIDOS = ['cuenta_por_defecto', 'estrategia_ingresos', 'meses_historial', 'ultimo_respaldo', 'bienvenida'];

/** Error usado para deshacer una importación de prueba (vista previa). */
class Simulacion extends Error {
  constructor(resultado) { super('simulación'); this.resultado = resultado; }
}

export function makeRespaldo(ctx) {
  const { db } = ctx;
  const ahora = () => {
    const d = ctx.now();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  // ================================================================== JSON

  /** Anota que se ha hecho una copia (la UI lo llama cuando el fichero se ha guardado/compartido). */
  async function marcarRespaldo() {
    await ctx.ajustes.set('ultimo_respaldo', ahora());
  }

  /** `marcar: false` si quien llama anotará la copia solo cuando el usuario la guarde de verdad. */
  async function exportarJSON({ marcar = true } = {}) {
    const datos = Object.fromEntries(TABLAS.map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY rowid`)]));
    const fecha = ahora();
    const contenido = JSON.stringify({
      app: 'mis-cuentas',
      formato: FORMATO_JSON,
      schema_version: db.schemaVersion,
      exportado_en: fecha,
      datos,
    }, null, 1);
    if (marcar) await ctx.ajustes.set('ultimo_respaldo', fecha);
    return { contenido, nombre: `mis-cuentas-${fecha.slice(0, 10)}.json`, tipo: 'application/json' };
  }

  function leerJSON(texto) {
    if (typeof texto !== 'string' || texto.length > MAX_BYTES) {
      throw new ValidationError('El fichero no es válido o es demasiado grande.', { code: 'json_invalido' });
    }
    let obj;
    try { obj = JSON.parse(texto.replace(/^﻿/, '')); } catch {
      throw new ValidationError('El fichero no es un JSON válido (¿está dañado o incompleto?).', { code: 'json_invalido' });
    }
    if (obj?.app !== 'mis-cuentas' || typeof obj.datos !== 'object' || obj.datos === null) {
      throw new ValidationError('Este fichero no es una copia de seguridad de esta app.', { code: 'json_ajeno' });
    }
    if (obj.formato !== FORMATO_JSON) {
      throw new ValidationError(`Formato de copia ${obj.formato} no soportado.`, { code: 'json_formato' });
    }
    if (!Number.isInteger(obj.schema_version) || obj.schema_version > LATEST_VERSION) {
      throw new ValidationError('La copia es de una versión más nueva de la app. Actualiza la app antes de restaurarla.',
        { code: 'json_version_futura' });
    }
    for (const t of TABLAS) {
      const filas = obj.datos[t] ?? [];
      if (!Array.isArray(filas) || filas.some((f) => typeof f !== 'object' || f === null || Array.isArray(f))) {
        throw new ValidationError(`La tabla «${t}» de la copia está dañada.`, { code: 'json_tabla' });
      }
    }
    return obj;
  }

  /** Resumen para confirmar antes de restaurar. */
  function resumenJSON(texto) {
    const obj = leerJSON(texto);
    const n = (t) => (obj.datos[t] ?? []).length;
    return {
      exportado_en: obj.exportado_en ?? null,
      movimientos: n('movimientos'),
      metas: n('metas_ahorro'),
      categorias: n('categorias'),
      cuentas: n('cuentas'),
      actuales: { movimientos: db.value('SELECT count(*) FROM movimientos') },
    };
  }

  /**
   * Sustituye TODOS los datos por los de la copia. Las restricciones y triggers del esquema
   * validan cada fila; ante el primer fallo se deshace todo y se indica tabla y fila.
   * Columnas desconocidas se ignoran y las que falten toman su valor por defecto, así una
   * copia de una versión anterior sigue sirviendo.
   */
  async function restaurarJSON(texto) {
    const obj = leerJSON(texto);
    await db.transaction((tx) => {
      // Primero los retiros: si se borrase antes un aporte, el trigger vería la meta en negativo.
      tx.run("DELETE FROM movimientos WHERE tipo = 'ahorro_retiro'");
      for (const t of [...TABLAS].reverse()) tx.run(`DELETE FROM ${t}`);
      for (const t of TABLAS) {
        const columnas = new Set(tx.all(`PRAGMA table_info(${t})`).map((c) => c.name));
        let filas = obj.datos[t] ?? [];
        if (t === 'ajustes') filas = filas.filter((f) => AJUSTES_CONOCIDOS.includes(f.clave));
        if (t === 'movimientos') {
          // Los retiros al final: así ninguna meta pasa por saldo negativo durante la carga.
          filas = [...filas].sort((a, b) => (a.tipo === 'ahorro_retiro') - (b.tipo === 'ahorro_retiro'));
        }
        filas.forEach((fila, i) => {
          const cols = Object.keys(fila).filter((c) => columnas.has(c));
          if (cols.length === 0) return;
          const params = Object.fromEntries(cols.map((c) => [`$${c}`, normalizarValor(fila[c])]));
          try {
            tx.run(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map((c) => `$${c}`).join(', ')})`, params);
          } catch (err) {
            throw new ValidationError(
              `La copia tiene un dato no válido en «${t}», fila ${i + 1}: ${err.message}`,
              { code: 'json_fila', cause: err },
            );
          }
        });
      }
      const rotas = tx.all('PRAGMA foreign_key_check');
      if (rotas.length) {
        throw new ValidationError(`La copia tiene ${rotas.length} referencia(s) rotas (p. ej. en «${rotas[0].table}»).`,
          { code: 'json_referencias' });
      }
      // La copia que se acaba de restaurar existe: cuenta como último respaldo.
      if (typeof obj.exportado_en === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(obj.exportado_en)) {
        tx.run(`INSERT INTO ajustes (clave, valor) VALUES ('ultimo_respaldo', $v)
                ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, { $v: obj.exportado_en });
      }
      // Restaurar una copia implica que la app ya estaba configurada.
      tx.run(`INSERT INTO ajustes (clave, valor) VALUES ('bienvenida', 'hecha')
              ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`);
      // Si la copia no trae cuenta por defecto válida, se usa la primera cuenta activa.
      const def = Number(tx.value("SELECT valor FROM ajustes WHERE clave = 'cuenta_por_defecto'"));
      if (!tx.value('SELECT 1 FROM cuentas WHERE id = $id AND activa = 1', { $id: def })) {
        const primera = tx.value('SELECT id FROM cuentas WHERE activa = 1 ORDER BY id LIMIT 1');
        if (primera) {
          tx.run(`INSERT INTO ajustes (clave, valor) VALUES ('cuenta_por_defecto', $v)
                  ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, { $v: String(primera) });
        }
      }
    });
    return resumenJSON(texto);
  }

  // =================================================================== CSV

  function exportarCSV({ desde, hasta } = {}) {
    const filtros = { limite: 500, offset: 0 };
    if (desde) filtros.desde = desde;
    if (hasta) filtros.hasta = hasta;
    // listar() pagina de 500 en 500: se recorren todas las páginas.
    const filas = [];
    for (;;) {
      const { items, total } = ctx.movimientos.listar(filtros);
      filas.push(...items);
      filtros.offset += items.length;
      if (items.length === 0 || filas.length >= total) break;
    }
    filas.reverse(); // cronológico
    const contenido = aCSV(filas, [
      { titulo: 'fecha', valor: (m) => m.fecha, seguro: true },
      { titulo: 'tipo', valor: (m) => m.tipo, seguro: true },
      { titulo: 'importe', valor: (m) => centsToInput(m.importe_cent), seguro: true },
      { titulo: 'categoria', valor: (m) => m.categoria },
      { titulo: 'meta', valor: (m) => m.meta },
      { titulo: 'cuenta', valor: (m) => m.cuenta },
      { titulo: 'nota', valor: (m) => m.nota },
    ]);
    return { contenido, nombre: `movimientos-${ahora().slice(0, 10)}.csv`, tipo: 'text/csv', filas: filas.length };
  }

  const ALIAS = {
    fecha: ['fecha', 'date', 'fecha_operacion', 'fecha_valor', 'f._valor', 'f._operacion'],
    tipo: ['tipo', 'type'],
    importe: ['importe', 'cantidad', 'amount', 'importe_(eur)', 'importe_eur', 'euros'],
    categoria: ['categoria', 'category'],
    meta: ['meta', 'objetivo'],
    cuenta: ['cuenta', 'account', 'metodo_de_pago', 'metodo'],
    nota: ['nota', 'notas', 'concepto', 'descripcion', 'description', 'detalle'],
  };
  const TIPOS_ALIAS = {
    gasto: 'gasto', gastos: 'gasto', cargo: 'gasto',
    ingreso: 'ingreso', ingresos: 'ingreso', abono: 'ingreso',
    ahorro_aporte: 'ahorro_aporte', aporte: 'ahorro_aporte', apartar: 'ahorro_aporte',
    ahorro_retiro: 'ahorro_retiro', retiro: 'ahorro_retiro', retirar: 'ahorro_retiro',
  };

  /**
   * Importa movimientos de un CSV (añade, no borra). Opciones:
   *   simular: true            → valida y calcula el resultado sin guardar nada (vista previa)
   *   crearCategorias: true    → categorías que no existan se crean (recortables si son de gasto)
   *   omitirDuplicados: true   → no vuelve a meter movimientos idénticos ya existentes
   * Sin columna «tipo»: importe negativo = gasto, positivo = ingreso (extractos de banco).
   * Sin categoría: «Otros gastos» / «Otros ingresos».
   * Todo o nada: si una fila falla, no se importa ninguna y se listan los errores.
   */
  async function importarCSV(texto, { simular = false, crearCategorias = true, omitirDuplicados = true } = {}) {
    if (typeof texto === 'string' && texto.length > MAX_BYTES) {
      throw new ValidationError('El fichero es demasiado grande.', { code: 'csv_grande' });
    }
    const { cabecera, filas } = leerCSV(texto);
    const idx = indicesColumnas(cabecera);
    if (idx.fecha === -1 || idx.importe === -1) {
      throw new ValidationError(
        `No encuentro las columnas «fecha» e «importe». Columnas del fichero: ${cabecera.join(', ')}.`,
        { code: 'csv_columnas' },
      );
    }

    const ejecutar = (tx) => {
      const r = { importados: 0, duplicados: 0, categorias_nuevas: [], errores: [] };
      const existentes = contarExistentes(tx);
      const catCache = new Map(tx.all('SELECT id, nombre, tipo FROM categorias').map((c) => [`${c.tipo}|${clave(c.nombre)}`, c.id]));
      const metas = new Map(tx.all('SELECT id, nombre FROM metas_ahorro').map((m) => [clave(m.nombre), m.id]));
      const cuentas = new Map(tx.all('SELECT id, nombre FROM cuentas').map((c) => [clave(c.nombre), c.id]));

      filas.forEach((celdas, i) => {
        const linea = i + 2; // +1 por la cabecera, +1 porque las filas empiezan en 1
        const col = (k) => (idx[k] === -1 ? '' : (celdas[idx[k]] ?? '').trim());
        // Cada fila en su SAVEPOINT: si falla, se deshace solo ella (también la categoría
        // que hubiera creado) y se siguen validando las demás para listar todos los errores.
        const catsAntes = r.categorias_nuevas.length;
        const clavesNuevas = [];
        tx.run('SAVEPOINT fila');
        try {
          const entrada = filaAEntrada({ col, catCache, metas, cuentas, crearCategorias, tx, r, clavesNuevas });
          const firma = firmaMovimiento(entrada);
          if (omitirDuplicados && (existentes.get(firma) ?? 0) > 0) {
            existentes.set(firma, existentes.get(firma) - 1);
            r.duplicados += 1;
          } else {
            ctx.movimientos.insertarEn(tx, entrada);
            r.importados += 1;
          }
          tx.run('RELEASE fila');
        } catch (err) {
          tx.run('ROLLBACK TO fila');
          tx.run('RELEASE fila');
          for (const k of clavesNuevas) catCache.delete(k);
          r.categorias_nuevas.length = catsAntes;
          if (!(err instanceof AppError)) throw err;
          if (r.errores.length < MAX_ERRORES) r.errores.push({ linea, mensaje: err.message });
          else r.errores_omitidos = (r.errores_omitidos ?? 0) + 1;
        }
      });

      if (r.errores.length) {
        const e = new ValidationError(
          `Hay ${r.errores.length + (r.errores_omitidos ?? 0)} fila(s) con errores; no se ha importado nada.`,
          { code: 'csv_filas' },
        );
        e.detalles = r.errores;
        throw e;
      }
      if (simular) throw new Simulacion(r);
      return r;
    };

    try {
      return await db.transaction(ejecutar);
    } catch (err) {
      if (err instanceof Simulacion) return { ...err.resultado, simulado: true };
      throw err;
    }
  }

  function indicesColumnas(cabecera) {
    const norm = cabecera.map(normalizarCabecera);
    return Object.fromEntries(Object.entries(ALIAS).map(([k, alias]) => [k, norm.findIndex((c) => alias.includes(c))]));
  }

  function filaAEntrada({ col, catCache, metas, cuentas, crearCategorias, tx, r, clavesNuevas }) {
    const fecha = parseFecha(col('fecha'));
    const firmado = parseImporteConSigno(col('importe'));
    if (firmado === 0) throw new ValidationError('El importe es 0.');

    let tipo;
    const tipoTexto = normalizarCabecera(col('tipo'));
    if (tipoTexto) {
      tipo = TIPOS_ALIAS[tipoTexto];
      if (!tipo) throw new ValidationError(`Tipo «${col('tipo')}» desconocido (usa gasto, ingreso, aporte o retiro).`);
    } else {
      tipo = firmado < 0 ? 'gasto' : 'ingreso';
    }
    const entrada = {
      fecha,
      tipo,
      importe_cent: Math.abs(firmado),
      nota: quitarApostrofo(col('nota')) || null,
    };

    if (tipo === 'gasto' || tipo === 'ingreso') {
      const nombre = quitarApostrofo(col('categoria')) || (tipo === 'gasto' ? 'Otros gastos' : 'Otros ingresos');
      const k = `${tipo}|${clave(nombre)}`;
      let catId = catCache.get(k);
      if (!catId) {
        const otroTipo = catCache.get(`${tipo === 'gasto' ? 'ingreso' : 'gasto'}|${clave(nombre)}`);
        if (!crearCategorias) {
          throw new ValidationError(`La categoría «${nombre}» no existe${otroTipo ? ` como ${tipo}` : ''}.`);
        }
        if (nombre.length > 60) throw new ValidationError('Nombre de categoría demasiado largo.');
        catId = tx.run('INSERT INTO categorias (nombre, tipo, recortable) VALUES ($n, $t, $r)',
          { $n: nombre, $t: tipo, $r: tipo === 'gasto' ? 1 : 0 }).lastId;
        catCache.set(k, catId);
        clavesNuevas.push(k);
        r.categorias_nuevas.push(`${nombre} (${tipo})`);
      }
      entrada.categoria_id = catId;
      const cuenta = quitarApostrofo(col('cuenta'));
      if (cuenta) {
        entrada.cuenta_id = cuentas.get(clave(cuenta));
        if (!entrada.cuenta_id) throw new ValidationError(`La cuenta «${cuenta}» no existe. Créala antes en Ajustes.`);
      }
    } else {
      const nombre = quitarApostrofo(col('meta'));
      if (!nombre) throw new ValidationError('Los aportes y retiros necesitan la columna «meta».');
      entrada.meta_id = metas.get(clave(nombre));
      if (!entrada.meta_id) throw new ValidationError(`La meta «${nombre}» no existe. Créala antes de importar.`);
    }
    return entrada;
  }

  function contarExistentes(tx) {
    const m = new Map();
    for (const f of tx.all('SELECT fecha, tipo, importe_cent, categoria_id, meta_id, nota FROM movimientos')) {
      const k = firmaMovimiento(f);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }

  // ============================================================ recordatorio

  /** Días desde la última copia (null si nunca) y si conviene recordarla. */
  function estadoRespaldo({ cadaDias = 7 } = {}) {
    const ultimo = ctx.ajustes.get('ultimo_respaldo');
    const movimientos = db.value('SELECT count(*) FROM movimientos');
    let dias = null;
    if (ultimo) {
      const [y, m, d] = ultimo.slice(0, 10).split('-').map(Number);
      const hoy = ctx.now();
      dias = Math.floor((Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()) - Date.UTC(y, m - 1, d)) / 86400000);
    }
    const primerMov = db.value('SELECT min(creado_en) FROM movimientos');
    return {
      ultimo,
      dias,
      movimientos,
      // Se recuerda si hay datos y hace más de N días (o nunca, tras unos días de uso).
      recordar: movimientos > 0 && (dias === null ? diasDesde(primerMov) >= 3 : dias >= cadaDias),
    };
  }

  function diasDesde(isoUtc) {
    if (!isoUtc) return 0;
    return Math.floor((ctx.now().getTime() - Date.parse(`${isoUtc}Z`)) / 86400000);
  }

  return { exportarJSON, marcarRespaldo, resumenJSON, restaurarJSON, exportarCSV, importarCSV, estadoRespaldo };
}

function firmaMovimiento(m) {
  return [m.fecha, m.tipo, m.importe_cent, m.categoria_id ?? '', m.meta_id ?? '', m.nota ?? ''].join('|');
}

function quitarApostrofo(s) {
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}

function normalizarValor(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v); // lo rechazará el CHECK/STRICT
  return v;
}
