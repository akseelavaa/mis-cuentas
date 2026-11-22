# Gastos y ahorros (PWA personal)

App web instalable en el iPhone. Los datos viven **solo en el teléfono**
(SQLite vía sql.js, guardado en IndexedDB).

## Estado

- [x] **Fase 1 – Base de datos:** esquema, migraciones, conexión, persistencia, utilidades de dinero y fechas.
- [x] **Fase 2 – Lógica de negocio:** movimientos, metas, presupuestos, gastos fijos, plan mensual, analítica.
- [x] **Fase 3 – Interfaz móvil + PWA:** instalable en el iPhone, funciona sin conexión.
- [x] **Fase 4 – Copias y portabilidad:** copia completa JSON, CSV para Excel, importar CSV (también extractos de banco), recordatorio semanal.

## Publicar la app y tenerla en el iPhone

La app es solo ficheros estáticos: no necesita servidor propio, pero sí una dirección
**HTTPS** (requisito de Safari para instalarla y para que funcione sin conexión).
Lo más sencillo y gratis es **GitHub Pages**:

1. Crea una cuenta en https://github.com y un repositorio nuevo, por ejemplo `mis-cuentas`
   (puede ser público: el código no contiene ningún dato tuyo).
2. En el repositorio: **Add file → Upload files** y arrastra el contenido de esta carpeta
   (todo menos `node_modules`). Pulsa **Commit changes**.
3. **Settings → Pages → Branch: `main` / `(root)` → Save**. En un minuto tendrás la
   dirección `https://TU-USUARIO.github.io/mis-cuentas/`.
4. En el iPhone, abre esa dirección **en Safari**, toca **Compartir → Añadir a pantalla de
   inicio**, y abre la app **siempre desde ese icono**.

⚠️ **Tus datos van ligados a esa dirección exacta.** Si cambias el nombre del repositorio o
de usuario, la app empezará vacía: haz antes una copia (Ajustes → Guardar copia de seguridad)
y restáurala en la dirección nueva.

## Copias de seguridad

- **Ajustes → Guardar copia de seguridad**: crea `mis-cuentas-AAAA-MM-DD.json` con todo y abre
  la hoja Compartir del iPhone → «Guardar en Archivos» (mejor en iCloud Drive).
- **Restaurar**: desde Ajustes o desde la pantalla de bienvenida de un móvil nuevo. Sustituye
  todos los datos; si la copia tiene algún problema, no se cambia nada.
- **CSV**: exporta los movimientos para Excel (`;` y coma decimal). Importar un CSV **añade**
  movimientos, enseña antes un resumen, omite los que ya tienes y crea las categorías que falten.
  Columnas: `fecha`, `importe` (obligatorias), `tipo`, `categoria`, `meta`, `cuenta`, `nota`.
  Sin `tipo`, un importe negativo es un gasto (sirve para extractos del banco).
- Si pasan 7 días sin copia, Inicio te lo recuerda.

### Publicar una versión nueva

1. Sube los ficheros cambiados al repositorio.
2. Antes, en `sw.js`, cambia `VERSION` (p. ej. `'v3-1'` → `'v3-2'`). Si no, los teléfonos
   seguirán usando la versión guardada.
3. Abre la app con conexión; te avisará de que hay versión nueva: ciérrala y vuelve a abrirla.
   Tus datos no se tocan.

### Probarla en el PC antes de publicar

```powershell
npx http-server -p 8080 -c-1
```
y abre http://localhost:8080 (en Chrome: F12 → icono de móvil para verla con tamaño de iPhone).

## Ejecutar las pruebas en Windows

1. Instala **Node.js LTS** (≥ 20) desde https://nodejs.org (instalador `.msi`).
2. Abre una terminal (PowerShell) en esta carpeta:

   ```powershell
   npm install
   npm test
   ```

Las pruebas usan SQLite en memoria; no tocan ningún dato real.

## Estructura

```
src/
  errors.js            Jerarquía de errores + traducción de errores de SQLite
  domain/money.js      Importes en céntimos: parseo "12,50", formato, reparto proporcional
  domain/dates.js      Fechas ISO, meses, rangos, día local (no UTC)
  db/migrations.js     Esquema SQL versionado (PRAGMA user_version)
  db/connection.js     Apertura, migraciones, transacciones, persistencia
  db/storage-idb.js    Guardado del fichero SQLite en IndexedDB (navegador)
  services/index.js    createServices(db): única puerta de la UI a la lógica
  services/movimientos.js  Alta/edición/borrado con reglas de saldo y avisos
  services/metas.js        Metas, progreso y aporte mensual necesario
  services/plan.js         Plan mensual: ingreso estimado, topes por categoría, proyección
  services/presupuestos.js Límites vigentes por mes y niveles ok/aviso/superado
  services/analitica.js    Resumen mensual, desglose por categoría, evolución
  services/respaldo.js     Copia JSON, CSV de movimientos, recordatorio
  domain/csv.js            Lectura/escritura CSV (Excel en español, extractos de banco)
  services/…               catálogo (cuentas, categorías), ajustes, saldos, previsiones
src/ui/               Interfaz: main.js (arranque y rutas), vistas/, formularios
index.html, css/, icons/, manifest.webmanifest, sw.js   PWA
vendor/                sql.js (SQLite para el navegador), copiado de node_modules
tests/                 node:test (sin dependencias extra)
```

## Uso desde la UI (ejemplo)

```js
const app = createServices(db);
const { movimiento, avisos } = await app.movimientos.crear({
  tipo: 'gasto', importe: '12,50', categoria_id: 7, nota: 'cine',
});
// avisos → [{ tipo: 'presupuesto', nivel: 'aviso', mensaje: 'Vas por 85,00 € de 100,00 € en Ocio…' }]
const plan = app.plan.calcular();     // mes actual
await app.plan.aceptar();             // guarda los topes como presupuestos
```

Los errores son `ValidationError` / `NotFoundError` / `ConflictError` / `BusinessRuleError`
con `message` en español listo para mostrar y `field` para marcar el campo del formulario.

## Reglas del código

- Dinero siempre en **céntimos enteros** (`*_cent`). Nunca floats.
- Fechas siempre `'YYYY-MM-DD'` / meses `'YYYY-MM'`, calculadas sin zonas horarias.
- Toda escritura va dentro de `db.transaction(fn)` con `fn` **síncrona**: todo o nada,
  y se persiste al terminar.
- Las migraciones publicadas no se editan: los cambios van en una migración nueva.
