// Jerarquía de errores de la app. La UI solo necesita mirar `err.code` y `err.message`
// (mensaje ya en español, apto para mostrar al usuario).

export class AppError extends Error {
  constructor(message, { code = 'error', field = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.field = field; // campo del formulario al que se refiere (si aplica)
  }
}

/** Dato de entrada inválido (formato, rango, campo obligatorio). */
export class ValidationError extends AppError {}

/** Se referencia algo que no existe (categoría, meta, cuenta…). */
export class NotFoundError extends AppError {}

/** Choca con algo existente (nombre duplicado, elemento en uso). */
export class ConflictError extends AppError {}

/** Viola una regla de negocio (saldo insuficiente, meta archivada…). */
export class BusinessRuleError extends AppError {}

/** Fallo técnico de almacenamiento: no es culpa del usuario. */
export class StorageError extends AppError {}

/** Uso incorrecto de la API interna (bug de programación, nunca del usuario). */
export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}

// Códigos lanzados con RAISE(ABORT, '<codigo>') desde los triggers del esquema.
const TRIGGER_CODES = {
  categoria_tipo_incompatible: [ValidationError, 'La categoría no corresponde al tipo de movimiento.'],
  categoria_en_uso: [ConflictError, 'No se puede cambiar el tipo de una categoría que ya se está usando.'],
  saldo_meta_negativo: [BusinessRuleError, 'La meta no tiene saldo suficiente para esta operación.'],
  meta_archivada_con_saldo: [BusinessRuleError, 'Solo se puede archivar una meta con saldo 0. Retira antes el dinero.'],
  presupuesto_categoria_no_gasto: [ValidationError, 'Los presupuestos solo pueden asignarse a categorías de gasto.'],
};

const UNIQUE_MESSAGES = {
  'cuentas.nombre': 'Ya existe una cuenta con ese nombre.',
  'categorias.nombre': 'Ya existe una categoría con ese nombre.',
  'metas_ahorro.nombre': 'Ya existe una meta con ese nombre.',
  'presupuestos.categoria_id': 'Ya hay un presupuesto para esa categoría desde ese mes.',
  'presupuestos.desde_mes': 'Ya hay un presupuesto definido desde ese mes.',
};

/**
 * Convierte un error crudo de SQLite en un AppError con mensaje legible.
 * Si no lo reconoce, devuelve un StorageError genérico conservando la causa.
 */
export function translateSqliteError(err) {
  if (err instanceof AppError) return err;
  // sql.js lanza `Error` a secas. TypeError, errores de uso, etc. son bugs nuestros:
  // se dejan pasar tal cual para no esconderlos tras un mensaje genérico.
  if (!(err instanceof Error) || err.constructor !== Error) return err;
  const msg = String(err?.message ?? err);

  for (const [code, [Cls, text]] of Object.entries(TRIGGER_CODES)) {
    if (msg.includes(code)) return new Cls(text, { code, cause: err });
  }

  if (msg.includes('FOREIGN KEY constraint failed')) {
    return new NotFoundError(
      'El elemento referenciado no existe o está en uso y no se puede borrar.',
      { code: 'fk', cause: err },
    );
  }

  const unique = msg.match(/UNIQUE constraint failed: ([\w.]+)/);
  if (unique) {
    const key = unique[1];
    return new ConflictError(UNIQUE_MESSAGES[key] ?? 'Ese elemento ya existe.', { code: 'duplicado', cause: err });
  }

  if (msg.includes('CHECK constraint failed') || msg.includes('NOT NULL constraint failed')
      || msg.includes('cannot store')) {
    // Si llegamos aquí, la validación de la capa de servicio no lo detectó: es un bug,
    // pero la BD ha protegido la integridad. Mensaje genérico + causa para depurar.
    return new ValidationError('Datos no válidos.', { code: 'restriccion', cause: err });
  }

  return new StorageError('Error interno de la base de datos.', { code: 'sqlite', cause: err });
}
