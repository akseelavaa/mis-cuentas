// Metas de ahorro: alta/edición, progreso y aporte mensual necesario.
import { BusinessRuleError, ConflictError, ValidationError } from '../errors.js';
import { parseImporte, formatImporte } from '../domain/money.js';
import { parseFechaOpcional, mesDe, mesesEntre, rangoMes, mesActual, hoy } from '../domain/dates.js';
import {
  parseId, parseTexto, parseEntero, parseEnum, clave, existe, fusionar,
} from './util.js';

const ESTADOS = ['activa', 'completada', 'archivada'];

/**
 * Cuánto hay que aportar a una meta en `mes`. Función pura (sin BD) → fácil de probar.
 *
 * Se calcula con el saldo al INICIO del mes, para que la cifra no cambie a medida que
 * vas aportando: "este mes tocan 180 €; llevas 50 €; te faltan 130 €".
 *
 *   alcanzada : saldo actual ≥ objetivo                    → 0
 *   en_curso  : con fecha límite → ceil(falta / meses restantes, incluido este y el de la fecha)
 *   vencida   : la fecha límite ya pasó                     → todo lo que falta
 *   cuota     : sin fecha pero con aporte mensual fijo      → min(cuota, falta)
 *   sin_fecha : ni fecha ni cuota                           → 0 (recibe lo que sobre)
 */
export function calcularAporteNecesario({ meta, mes, saldoInicioMes, saldoActual, netoMes }) {
  const falta = Math.max(0, meta.objetivo_cent - saldoInicioMes);
  const base = { falta_inicio_mes_cent: falta, meses_restantes: null };

  let estado;
  let necesario = 0;
  if (meta.estado !== 'activa') {
    estado = meta.estado;
  } else if (saldoActual >= meta.objetivo_cent) {
    estado = 'alcanzada';
  } else if (meta.fecha_limite) {
    const meses = mesesEntre(mes, mesDe(meta.fecha_limite)) + 1;
    base.meses_restantes = Math.max(0, meses);
    if (meses <= 0) {
      estado = 'vencida';
      necesario = falta;
    } else {
      estado = 'en_curso';
      necesario = Math.ceil(falta / meses);
    }
  } else if (meta.aporte_mensual_cent) {
    estado = 'cuota';
    necesario = Math.min(meta.aporte_mensual_cent, falta);
  } else {
    estado = 'sin_fecha';
  }

  return {
    ...base,
    estado_plan: estado,
    necesario_mes_cent: necesario,
    aportado_mes_cent: netoMes,
    pendiente_mes_cent: Math.max(0, necesario - netoMes),
  };
}

export function makeMetas(ctx) {
  const { db } = ctx;

  function obtenerFila(id, q = db) {
    return existe(
      q.get('SELECT * FROM metas_ahorro WHERE id = $id', { $id: parseId(id, { field: 'meta_id', label: 'la meta' }) }),
      'La meta no existe.', 'meta_id',
    );
  }

  function saldo(id, q = db) {
    return q.value('SELECT saldo_cent FROM v_saldo_metas WHERE meta_id = $id', { $id: id }) ?? 0;
  }

  function validar(input, actual = null) {
    const nombre = parseTexto(input.nombre, { field: 'nombre', label: 'el nombre', max: 60 });
    const otras = db.all('SELECT id, nombre FROM metas_ahorro');
    if (otras.some((m) => m.id !== actual?.id && clave(m.nombre) === clave(nombre))) {
      throw new ConflictError('Ya existe una meta con ese nombre.', { code: 'duplicado', field: 'nombre' });
    }
    const fecha = parseFechaOpcional(input.fecha_limite, { field: 'fecha_limite' });
    const fechaCambia = fecha !== (actual?.fecha_limite ?? null);
    if (fecha && fechaCambia && fecha < hoy(ctx.now())) {
      throw new ValidationError('La fecha límite ya ha pasado.', { code: 'fecha_pasada', field: 'fecha_limite' });
    }
    return {
      $nombre: nombre,
      $objetivo: parseImporte(input.objetivo, { field: 'objetivo' }),
      $fecha: fecha,
      $cuota: input.aporte_mensual === undefined || input.aporte_mensual === null || input.aporte_mensual === ''
        ? null : parseImporte(input.aporte_mensual, { field: 'aporte_mensual' }),
      $prioridad: parseEntero(input.prioridad, { field: 'prioridad', label: 'la prioridad', min: 1, max: 5, defecto: 3 }),
    };
  }

  /** Meta con saldo, progreso y lo que toca aportar en `mes`. */
  function conProgreso(meta, mes) {
    const { desde, hasta } = rangoMes(mes);
    const r = db.get(`SELECT
        COALESCE(SUM(CASE WHEN fecha < $desde THEN (CASE tipo WHEN 'ahorro_aporte' THEN importe_cent ELSE -importe_cent END) END), 0) AS inicio,
        COALESCE(SUM(CASE WHEN fecha >= $desde AND fecha < $hasta THEN (CASE tipo WHEN 'ahorro_aporte' THEN importe_cent ELSE -importe_cent END) END), 0) AS neto_mes,
        COALESCE(SUM(CASE tipo WHEN 'ahorro_aporte' THEN importe_cent ELSE -importe_cent END), 0) AS actual
      FROM movimientos WHERE meta_id = $id`, { $id: meta.id, $desde: desde, $hasta: hasta });
    const progreso = Math.min(1, r.actual / meta.objetivo_cent);
    return {
      ...meta,
      saldo_cent: r.actual,
      falta_cent: Math.max(0, meta.objetivo_cent - r.actual),
      progreso, // 0..1 (ratio para mostrar, no dinero)
      ...calcularAporteNecesario({ meta, mes, saldoInicioMes: r.inicio, saldoActual: r.actual, netoMes: r.neto_mes }),
    };
  }

  return {
    saldo,
    obtenerFila,

    obtener(id, { mes = mesActual(ctx.now()) } = {}) {
      return conProgreso(obtenerFila(id), mes);
    },

    /** Ordenadas por prioridad (1 primero) y luego por fecha límite más próxima. */
    listar({ mes = mesActual(ctx.now()), incluirArchivadas = false } = {}) {
      const filas = db.all(`SELECT * FROM metas_ahorro
        ${incluirArchivadas ? '' : "WHERE estado <> 'archivada'"}
        ORDER BY prioridad, fecha_limite IS NULL, fecha_limite, nombre`);
      return filas.map((m) => conProgreso(m, mes));
    },

    /**
     * Crea la meta. `saldo_inicial` opcional: si ya tienes dinero apartado para ella,
     * se registra como primer aporte (hoy) y debe caber en tu disponible.
     */
    async crear(input) {
      const p = validar(input);
      const inicial = input.saldo_inicial === undefined || input.saldo_inicial === null || input.saldo_inicial === ''
        ? 0 : parseImporte(input.saldo_inicial, { field: 'saldo_inicial' });
      const id = await db.transaction((tx) => {
        const metaId = tx.run(`INSERT INTO metas_ahorro (nombre, objetivo_cent, fecha_limite, aporte_mensual_cent, prioridad)
                               VALUES ($nombre, $objetivo, $fecha, $cuota, $prioridad)`, p).lastId;
        if (inicial > 0) {
          tx.run(`INSERT INTO movimientos (fecha, importe_cent, tipo, meta_id, nota)
                  VALUES ($f, $i, 'ahorro_aporte', $m, 'Saldo inicial')`, { $f: hoy(ctx.now()), $i: inicial, $m: metaId });
          const { disponible_cent: disp } = ctx.saldos.calcular(tx);
          if (disp < 0) {
            throw new BusinessRuleError(
              `No tienes suficiente dinero disponible para apartar ${formatImporte(inicial)} `
              + `(disponible: ${formatImporte(disp + inicial)}). Revisa el saldo inicial de tus cuentas.`,
              { code: 'disponible_insuficiente', field: 'saldo_inicial' },
            );
          }
        }
        return metaId;
      });
      return this.obtener(id);
    },

    async editar(id, cambios) {
      const actual = obtenerFila(id);
      const datos = fusionar({
        nombre: actual.nombre,
        objetivo: actual.objetivo_cent / 100,
        fecha_limite: actual.fecha_limite,
        aporte_mensual: actual.aporte_mensual_cent === null ? null : actual.aporte_mensual_cent / 100,
        prioridad: actual.prioridad,
      }, cambios, ['nombre', 'objetivo', 'fecha_limite', 'aporte_mensual', 'prioridad']);
      const p = validar(datos, actual);
      await db.transaction((tx) => tx.run(`UPDATE metas_ahorro SET nombre = $nombre, objetivo_cent = $objetivo,
          fecha_limite = $fecha, aporte_mensual_cent = $cuota, prioridad = $prioridad WHERE id = $id`,
      { ...p, $id: actual.id }));
      return this.obtener(actual.id);
    },

    async cambiarEstado(id, estado) {
      const actual = obtenerFila(id);
      parseEnum(estado, ESTADOS, { field: 'estado', label: 'el estado' });
      if (estado === 'archivada') {
        const s = saldo(actual.id);
        if (s !== 0) {
          throw new BusinessRuleError(
            `La meta aún tiene ${formatImporte(s)}. Retíralos antes de archivarla.`, { code: 'meta_archivada_con_saldo' });
        }
      }
      await db.transaction((tx) => tx.run('UPDATE metas_ahorro SET estado = $e WHERE id = $id', { $e: estado, $id: actual.id }));
      return this.obtener(actual.id);
    },

    async eliminar(id) {
      const actual = obtenerFila(id);
      if (db.value('SELECT 1 FROM movimientos WHERE meta_id = $id LIMIT 1', { $id: actual.id })) {
        throw new ConflictError('La meta tiene movimientos. Retira el saldo y archívala en lugar de borrarla.',
          { code: 'en_uso' });
      }
      await db.transaction((tx) => tx.run('DELETE FROM metas_ahorro WHERE id = $id', { $id: actual.id }));
    },
  };
}
