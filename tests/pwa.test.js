// La app solo funciona sin conexión si el service worker precarga TODOS sus ficheros.
// Esta prueba falla si añades un módulo y olvidas incluirlo en sw.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('..', import.meta.url));

function listar(dir) {
  return readdirSync(join(raiz, dir)).flatMap((n) => {
    const ruta = join(raiz, dir, n);
    return statSync(ruta).isDirectory() ? listar(relative(raiz, ruta)) : [relative(raiz, ruta).replaceAll('\\', '/')];
  });
}

const sw = readFileSync(join(raiz, 'sw.js'), 'utf8');
const precarga = [...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]);

test('sw.js precarga todos los ficheros de la app', () => {
  const necesarios = [
    'index.html', 'manifest.webmanifest',
    ...listar('src'), ...listar('css'), ...listar('icons'),
    ...listar('vendor').filter((f) => !f.endsWith('LICENSE')),
  ];
  const faltan = necesarios.filter((f) => !precarga.includes(f));
  assert.deepEqual(faltan, [], `Añade a ARCHIVOS en sw.js: ${faltan.join(', ')}`);
});

test('todo lo que precarga sw.js existe', () => {
  const inexistentes = precarga.filter((f) => f !== './' && !existsSync(join(raiz, f)));
  assert.deepEqual(inexistentes, []);
});

test('el manifest es JSON válido y sus iconos existen', () => {
  const m = JSON.parse(readFileSync(join(raiz, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.ok(existsSync(join(raiz, i.src)), i.src);
});
