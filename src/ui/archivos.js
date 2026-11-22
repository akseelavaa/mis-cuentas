// Guardar y abrir ficheros desde la app, con atención especial al iPhone.
//
// Guardar: en iPhone se usa la hoja «Compartir» del sistema (navigator.share con ficheros),
// que ofrece «Guardar en Archivos», iCloud Drive, Mail, WhatsApp… En el PC, descarga normal.
// Trampa: Safari solo permite share() justo después de un toque del usuario. Si preparar
// el fichero tarda y el permiso caduca (NotAllowedError), se muestra un botón para
// compartir con un toque nuevo.
import { h, abrirHoja } from './dom.js';

/**
 * Devuelve true si el fichero se compartió o descargó, false si el usuario canceló.
 */
export async function guardarArchivo({ contenido, nombre, tipo }) {
  const blob = new Blob([contenido], { type: `${tipo};charset=utf-8` });
  const fichero = new File([blob], nombre, { type: tipo });

  if (navigator.canShare?.({ files: [fichero] })) {
    try {
      await navigator.share({ files: [fichero], title: nombre });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false; // el usuario cerró la hoja
      if (err.name === 'NotAllowedError') return compartirConToqueNuevo(fichero, blob, nombre);
      // Cualquier otro fallo: probamos la descarga clásica.
    }
  }
  descargar(blob, nombre);
  return true;
}

function compartirConToqueNuevo(fichero, blob, nombre) {
  return abrirHoja('Copia lista', (cerrar) => h('div', {},
    h('p', {}, `«${nombre}» está preparada.`),
    h('button', {
      class: 'btn bloque',
      onclick: async () => {
        try {
          await navigator.share({ files: [fichero], title: nombre });
          cerrar(true);
        } catch (err) {
          if (err.name === 'AbortError') cerrar(false);
          else { descargar(blob, nombre); cerrar(true); }
        }
      },
    }, 'Guardar o enviar'))).then((v) => v === true);
}

function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: nombre, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Abre el selector de ficheros (en iPhone, la app Archivos). Devuelve el texto o null. */
export function elegirArchivo(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) { resolve(null); return; }
      resolve({ nombre: f.name, texto: await f.text() });
    });
    // Si el usuario cancela, no siempre llega 'change': 'cancel' existe en navegadores recientes.
    input.addEventListener('cancel', () => { input.remove(); resolve(null); });
    document.body.append(input);
    input.click();
  });
}
