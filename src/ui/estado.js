// Estado compartido de la interfaz (un único objeto, sin framework).
import { mesActual } from '../domain/dates.js';

export const estado = {
  app: null,          // createServices(db)
  db: null,
  persistente: null,  // ¿el navegador garantiza no borrar los datos?
  mes: mesActual(),   // mes seleccionado en Movimientos / Gastos
  refrescar: () => {},
};
