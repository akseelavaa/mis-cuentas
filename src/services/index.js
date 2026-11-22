// Punto de entrada de la lógica de negocio. La UI solo habla con este objeto.
//
//   const app = createServices(db);
//   const { movimiento, avisos } = await app.movimientos.crear({ tipo: 'gasto', importe: '12,50', categoria_id: 6 });
//   const plan = app.plan.calcular('2026-11');
//
// `now` se inyecta para poder probar "hoy" y "este mes" de forma determinista.
import { makeCatalogo } from './catalogo.js';
import { makeAjustes } from './ajustes.js';
import { makeSaldos } from './saldos.js';
import { makeMetas } from './metas.js';
import { makePresupuestos } from './presupuestos.js';
import { makePrevisiones } from './previsiones.js';
import { makeMovimientos } from './movimientos.js';
import { makeAnalitica } from './analitica.js';
import { makePlan } from './plan.js';
import { makeRespaldo } from './respaldo.js';

export function createServices(db, { now = () => new Date() } = {}) {
  const ctx = { db, now };
  ctx.catalogo = makeCatalogo(ctx);
  ctx.ajustes = makeAjustes(ctx);
  ctx.saldos = makeSaldos(ctx);
  ctx.metas = makeMetas(ctx);
  ctx.presupuestos = makePresupuestos(ctx);
  ctx.previsiones = makePrevisiones(ctx);
  ctx.movimientos = makeMovimientos(ctx);
  ctx.analitica = makeAnalitica(ctx);
  ctx.plan = makePlan(ctx);
  ctx.respaldo = makeRespaldo(ctx);

  return {
    cuentas: ctx.catalogo.cuentas,
    categorias: ctx.catalogo.categorias,
    ajustes: ctx.ajustes,
    saldos: ctx.saldos,
    metas: ctx.metas,
    presupuestos: ctx.presupuestos,
    previsiones: ctx.previsiones,
    movimientos: ctx.movimientos,
    analitica: ctx.analitica,
    plan: ctx.plan,
    respaldo: ctx.respaldo,
  };
}
