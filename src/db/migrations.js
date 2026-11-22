// Migraciones del esquema. Cada una se aplica UNA vez, en orden, dentro de una transacción,
// y deja PRAGMA user_version = version. Nunca se edita una migración ya publicada:
// los cambios van en una nueva (002, 003…).

export const MIGRATIONS = [
  {
    version: 1,
    nombre: 'esquema inicial',
    sql: /* sql */ `
-- ============================================================
-- CUENTAS / MÉTODOS DE PAGO
-- ============================================================
CREATE TABLE cuentas (
    id                  INTEGER PRIMARY KEY,
    nombre              TEXT    NOT NULL COLLATE NOCASE UNIQUE
                                CHECK (length(trim(nombre)) BETWEEN 1 AND 60),
    tipo                TEXT    NOT NULL DEFAULT 'banco'
                                CHECK (tipo IN ('efectivo','banco','tarjeta','otro')),
    saldo_inicial_cent  INTEGER NOT NULL DEFAULT 0
                                CHECK (abs(saldo_inicial_cent) <= 100000000000),
    activa              INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1)),
    creado_en           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now'))
) STRICT;

-- ============================================================
-- CATEGORÍAS (solo gasto / ingreso)
-- ============================================================
CREATE TABLE categorias (
    id          INTEGER PRIMARY KEY,
    nombre      TEXT    NOT NULL COLLATE NOCASE
                        CHECK (length(trim(nombre)) BETWEEN 1 AND 60),
    tipo        TEXT    NOT NULL CHECK (tipo IN ('gasto','ingreso')),
    icono       TEXT    CHECK (icono IS NULL OR length(icono) <= 8),
    recortable  INTEGER NOT NULL DEFAULT 1 CHECK (recortable IN (0,1)),  -- ¿el plan puede recortarla?
    activa      INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1)),
    UNIQUE (nombre, tipo)
) STRICT;

-- ============================================================
-- METAS DE AHORRO (el saldo NO se guarda: se calcula en v_saldo_metas)
-- ============================================================
CREATE TABLE metas_ahorro (
    id                   INTEGER PRIMARY KEY,
    nombre               TEXT    NOT NULL COLLATE NOCASE UNIQUE
                                 CHECK (length(trim(nombre)) BETWEEN 1 AND 60),
    objetivo_cent        INTEGER NOT NULL CHECK (objetivo_cent > 0 AND objetivo_cent <= 100000000000),
    fecha_limite         TEXT    CHECK (fecha_limite IS NULL OR date(fecha_limite) IS fecha_limite),
    aporte_mensual_cent  INTEGER CHECK (aporte_mensual_cent IS NULL OR aporte_mensual_cent > 0),
    prioridad            INTEGER NOT NULL DEFAULT 3 CHECK (prioridad BETWEEN 1 AND 5), -- 1 = la más importante
    estado               TEXT    NOT NULL DEFAULT 'activa'
                                 CHECK (estado IN ('activa','completada','archivada')),
    creado_en            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now'))
) STRICT;

-- ============================================================
-- MOVIMIENTOS
-- ============================================================
CREATE TABLE movimientos (
    id              INTEGER PRIMARY KEY,
    fecha           TEXT    NOT NULL CHECK (date(fecha) IS fecha),   -- IS, no =  (ver notas)
    importe_cent    INTEGER NOT NULL CHECK (importe_cent > 0 AND importe_cent <= 100000000000),
    tipo            TEXT    NOT NULL CHECK (tipo IN ('gasto','ingreso','ahorro_aporte','ahorro_retiro')),
    categoria_id    INTEGER REFERENCES categorias(id)   ON DELETE RESTRICT,
    meta_id         INTEGER REFERENCES metas_ahorro(id) ON DELETE RESTRICT,
    cuenta_id       INTEGER REFERENCES cuentas(id)      ON DELETE RESTRICT,
    nota            TEXT    CHECK (nota IS NULL OR length(nota) <= 500),
    creado_en       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now')),
    actualizado_en  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now')),
    CHECK (
        (tipo IN ('gasto','ingreso')
            AND categoria_id IS NOT NULL AND meta_id IS NULL AND cuenta_id IS NOT NULL)
     OR (tipo IN ('ahorro_aporte','ahorro_retiro')
            AND meta_id IS NOT NULL AND categoria_id IS NULL)
    )
) STRICT;

-- ============================================================
-- PRESUPUESTOS: vigentes desde un mes hasta que otro los sustituya
-- ============================================================
CREATE TABLE presupuestos (
    id                INTEGER PRIMARY KEY,
    categoria_id      INTEGER REFERENCES categorias(id) ON DELETE CASCADE,  -- NULL = límite general
    desde_mes         TEXT    NOT NULL
                      CHECK (desde_mes GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
                             AND date(desde_mes || '-01') IS desde_mes || '-01'),
    limite_cent       INTEGER CHECK (limite_cent IS NULL OR limite_cent > 0), -- NULL = sin límite desde aquí
    umbral_aviso_pct  INTEGER NOT NULL DEFAULT 80 CHECK (umbral_aviso_pct BETWEEN 1 AND 100)
) STRICT;

-- En SQLite los NULL son distintos entre sí en un UNIQUE: hacen falta dos índices parciales.
CREATE UNIQUE INDEX ux_presup_categoria ON presupuestos(categoria_id, desde_mes)
    WHERE categoria_id IS NOT NULL;
CREATE UNIQUE INDEX ux_presup_general   ON presupuestos(desde_mes)
    WHERE categoria_id IS NULL;

-- ============================================================
-- PREVISIONES: gastos fijos (alquiler, suscripciones) e ingresos esperados
-- ============================================================
CREATE TABLE previsiones (
    id            INTEGER PRIMARY KEY,
    nombre        TEXT    NOT NULL CHECK (length(trim(nombre)) BETWEEN 1 AND 60),
    tipo          TEXT    NOT NULL CHECK (tipo IN ('gasto','ingreso')),
    categoria_id  INTEGER NOT NULL REFERENCES categorias(id) ON DELETE RESTRICT,
    importe_cent  INTEGER NOT NULL CHECK (importe_cent > 0 AND importe_cent <= 100000000000),
    dia_mes       INTEGER CHECK (dia_mes IS NULL OR dia_mes BETWEEN 1 AND 31),
    activa        INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1))
) STRICT;

-- ============================================================
-- AJUSTES (clave/valor)
-- ============================================================
CREATE TABLE ajustes (
    clave  TEXT PRIMARY KEY,
    valor  TEXT
) STRICT;

-- ============================================================
-- ÍNDICES
-- ============================================================
CREATE INDEX ix_mov_fecha           ON movimientos(fecha);
CREATE INDEX ix_mov_tipo_fecha      ON movimientos(tipo, fecha);
CREATE INDEX ix_mov_categoria_fecha ON movimientos(categoria_id, fecha) WHERE categoria_id IS NOT NULL;
CREATE INDEX ix_mov_meta_fecha      ON movimientos(meta_id, fecha)      WHERE meta_id IS NOT NULL;
CREATE INDEX ix_mov_cuenta_fecha    ON movimientos(cuenta_id, fecha);
CREATE INDEX ix_prev_categoria      ON previsiones(categoria_id);

-- ============================================================
-- VISTA: saldo de cada meta
-- ============================================================
CREATE VIEW v_saldo_metas AS
SELECT m.id AS meta_id, m.nombre, m.objetivo_cent, m.estado,
       COALESCE(SUM(CASE mv.tipo WHEN 'ahorro_aporte' THEN  mv.importe_cent
                                 WHEN 'ahorro_retiro' THEN -mv.importe_cent END), 0) AS saldo_cent
FROM metas_ahorro m
LEFT JOIN movimientos mv ON mv.meta_id = m.id
GROUP BY m.id;

-- ============================================================
-- TRIGGERS (reglas que un CHECK no puede expresar)
-- ============================================================
-- 1) Tipo de categoría = tipo de movimiento / previsión.
--    Con EXISTS, una categoría inexistente no dispara el trigger y la detecta la FK
--    (error "no existe" en vez de un engañoso "tipo incompatible").
CREATE TRIGGER trg_mov_cat_tipo_ins BEFORE INSERT ON movimientos
WHEN NEW.categoria_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'categoria_tipo_incompatible')
    WHERE EXISTS (SELECT 1 FROM categorias WHERE id = NEW.categoria_id AND tipo IS NOT NEW.tipo);
END;
CREATE TRIGGER trg_mov_cat_tipo_upd BEFORE UPDATE OF categoria_id, tipo ON movimientos
WHEN NEW.categoria_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'categoria_tipo_incompatible')
    WHERE EXISTS (SELECT 1 FROM categorias WHERE id = NEW.categoria_id AND tipo IS NOT NEW.tipo);
END;
CREATE TRIGGER trg_prev_cat_tipo_ins BEFORE INSERT ON previsiones
BEGIN
    SELECT RAISE(ABORT, 'categoria_tipo_incompatible')
    WHERE EXISTS (SELECT 1 FROM categorias WHERE id = NEW.categoria_id AND tipo IS NOT NEW.tipo);
END;
CREATE TRIGGER trg_prev_cat_tipo_upd BEFORE UPDATE OF categoria_id, tipo ON previsiones
BEGIN
    SELECT RAISE(ABORT, 'categoria_tipo_incompatible')
    WHERE EXISTS (SELECT 1 FROM categorias WHERE id = NEW.categoria_id AND tipo IS NOT NEW.tipo);
END;
CREATE TRIGGER trg_cat_tipo_inmutable BEFORE UPDATE OF tipo ON categorias
WHEN NEW.tipo IS NOT OLD.tipo AND (
       EXISTS (SELECT 1 FROM movimientos  WHERE categoria_id = OLD.id)
    OR EXISTS (SELECT 1 FROM previsiones  WHERE categoria_id = OLD.id)
    OR EXISTS (SELECT 1 FROM presupuestos WHERE categoria_id = OLD.id))
BEGIN
    SELECT RAISE(ABORT, 'categoria_en_uso');
END;

-- 2) El saldo final de una meta nunca puede quedar negativo (alta, edición, borrado)
CREATE TRIGGER trg_meta_saldo_ins AFTER INSERT ON movimientos
WHEN NEW.meta_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'saldo_meta_negativo')
    WHERE (SELECT saldo_cent FROM v_saldo_metas WHERE meta_id = NEW.meta_id) < 0;
END;
CREATE TRIGGER trg_meta_saldo_upd AFTER UPDATE ON movimientos
WHEN OLD.meta_id IS NOT NULL OR NEW.meta_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'saldo_meta_negativo')
    WHERE (SELECT MIN(saldo_cent) FROM v_saldo_metas
           WHERE meta_id IN (OLD.meta_id, NEW.meta_id)) < 0;
END;
CREATE TRIGGER trg_meta_saldo_del AFTER DELETE ON movimientos
WHEN OLD.meta_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'saldo_meta_negativo')
    WHERE (SELECT saldo_cent FROM v_saldo_metas WHERE meta_id = OLD.meta_id) < 0;
END;

-- 3) Solo se archiva una meta vacía
CREATE TRIGGER trg_meta_archivar BEFORE UPDATE OF estado ON metas_ahorro
WHEN NEW.estado = 'archivada'
BEGIN
    SELECT RAISE(ABORT, 'meta_archivada_con_saldo')
    WHERE (SELECT saldo_cent FROM v_saldo_metas WHERE meta_id = OLD.id) <> 0;
END;

-- 4) Presupuestos solo sobre categorías de gasto
CREATE TRIGGER trg_presup_cat_gasto_ins BEFORE INSERT ON presupuestos
WHEN NEW.categoria_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'presupuesto_categoria_no_gasto')
    WHERE EXISTS (SELECT 1 FROM categorias WHERE id = NEW.categoria_id AND tipo IS NOT 'gasto');
END;
CREATE TRIGGER trg_presup_cat_gasto_upd BEFORE UPDATE OF categoria_id ON presupuestos
WHEN NEW.categoria_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'presupuesto_categoria_no_gasto')
    WHERE EXISTS (SELECT 1 FROM categorias WHERE id = NEW.categoria_id AND tipo IS NOT 'gasto');
END;

-- ============================================================
-- DATOS INICIALES
-- ============================================================
INSERT INTO cuentas (nombre, tipo) VALUES ('Principal', 'banco');

INSERT INTO categorias (nombre, tipo, icono, recortable) VALUES
    ('Supermercado',         'gasto',   '🛒', 0),
    ('Vivienda',             'gasto',   '🏠', 0),
    ('Facturas',             'gasto',   '💡', 0),
    ('Transporte',           'gasto',   '🚌', 0),
    ('Salud',                'gasto',   '💊', 0),
    ('Restaurantes y bares', 'gasto',   '🍽️', 1),
    ('Ocio',                 'gasto',   '🎉', 1),
    ('Ropa y compras',       'gasto',   '🛍️', 1),
    ('Suscripciones',        'gasto',   '📺', 1),
    ('Otros gastos',         'gasto',   '📦', 1),
    ('Nómina',               'ingreso', '💼', 0),
    ('Trabajos extra',       'ingreso', '🧾', 0),
    ('Regalos',              'ingreso', '🎁', 0),
    ('Otros ingresos',       'ingreso', '💰', 0);

INSERT INTO ajustes (clave, valor) VALUES
    ('cuenta_por_defecto',   '1'),
    ('estrategia_ingresos',  'minimo'),  -- ingresos variables: plan prudente con el mínimo reciente
    ('meses_historial',      '3'),
    ('ultimo_respaldo',      NULL);
`,
  },
  {
    version: 2,
    nombre: 'presupuestos: permitir límite 0',
    // SQLite no permite modificar un CHECK: se reconstruye la tabla (procedimiento oficial).
    // trg_cat_tipo_inmutable menciona presupuestos en su cuerpo; se recrea para que el
    // RENAME no falle por una referencia colgante durante el cambio.
    sql: /* sql */ `
DROP TRIGGER trg_cat_tipo_inmutable;

CREATE TABLE presupuestos_nueva (
    id                INTEGER PRIMARY KEY,
    categoria_id      INTEGER REFERENCES categorias(id) ON DELETE CASCADE,
    desde_mes         TEXT    NOT NULL
                      CHECK (desde_mes GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
                             AND date(desde_mes || '-01') IS desde_mes || '-01'),
    limite_cent       INTEGER CHECK (limite_cent IS NULL OR limite_cent >= 0), -- 0 = "nada este mes"
    umbral_aviso_pct  INTEGER NOT NULL DEFAULT 80 CHECK (umbral_aviso_pct BETWEEN 1 AND 100)
) STRICT;

INSERT INTO presupuestos_nueva (id, categoria_id, desde_mes, limite_cent, umbral_aviso_pct)
    SELECT id, categoria_id, desde_mes, limite_cent, umbral_aviso_pct FROM presupuestos;
DROP TABLE presupuestos;
ALTER TABLE presupuestos_nueva RENAME TO presupuestos;

CREATE UNIQUE INDEX ux_presup_categoria ON presupuestos(categoria_id, desde_mes)
    WHERE categoria_id IS NOT NULL;
CREATE UNIQUE INDEX ux_presup_general   ON presupuestos(desde_mes)
    WHERE categoria_id IS NULL;

CREATE TRIGGER trg_presup_cat_gasto_ins BEFORE INSERT ON presupuestos
WHEN NEW.categoria_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'presupuesto_categoria_no_gasto')
    WHERE EXISTS (SELECT 1 FROM categorias WHERE id = NEW.categoria_id AND tipo IS NOT 'gasto');
END;
CREATE TRIGGER trg_presup_cat_gasto_upd BEFORE UPDATE OF categoria_id ON presupuestos
WHEN NEW.categoria_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'presupuesto_categoria_no_gasto')
    WHERE EXISTS (SELECT 1 FROM categorias WHERE id = NEW.categoria_id AND tipo IS NOT 'gasto');
END;
CREATE TRIGGER trg_cat_tipo_inmutable BEFORE UPDATE OF tipo ON categorias
WHEN NEW.tipo IS NOT OLD.tipo AND (
       EXISTS (SELECT 1 FROM movimientos  WHERE categoria_id = OLD.id)
    OR EXISTS (SELECT 1 FROM previsiones  WHERE categoria_id = OLD.id)
    OR EXISTS (SELECT 1 FROM presupuestos WHERE categoria_id = OLD.id))
BEGIN
    SELECT RAISE(ABORT, 'categoria_en_uso');
END;
`,
  },
];

export const LATEST_VERSION = MIGRATIONS.at(-1).version;
