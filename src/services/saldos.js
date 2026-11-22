// Dinero total, reservado en metas y disponible para gastar (modelo de "sobres").
//
//   saldo_total = Σ saldo inicial de cuentas + Σ ingresos − Σ gastos
//   reservado   = Σ saldo de metas (aportes − retiros)
//   disponible  = saldo_total − reservado
//
// Los aportes/retiros NO mueven dinero entre cuentas: solo lo apartan.

export function makeSaldos(ctx) {
  const { db } = ctx;

  /** Síncrono: se puede usar dentro de una transacción (q = tx). */
  function calcular(q = db) {
    const r = q.get(`SELECT
        (SELECT COALESCE(SUM(saldo_inicial_cent), 0) FROM cuentas) AS inicial,
        (SELECT COALESCE(SUM(importe_cent), 0) FROM movimientos WHERE tipo = 'ingreso') AS ingresos,
        (SELECT COALESCE(SUM(importe_cent), 0) FROM movimientos WHERE tipo = 'gasto') AS gastos,
        (SELECT COALESCE(SUM(saldo_cent), 0) FROM v_saldo_metas) AS reservado`);
    const total = r.inicial + r.ingresos - r.gastos;
    return { total_cent: total, reservado_cent: r.reservado, disponible_cent: total - r.reservado };
  }

  function porCuenta() {
    return db.all(`
      SELECT c.id, c.nombre, c.tipo, c.activa,
             c.saldo_inicial_cent
               + COALESCE(SUM(CASE m.tipo WHEN 'ingreso' THEN m.importe_cent
                                          WHEN 'gasto'   THEN -m.importe_cent END), 0) AS saldo_cent
      FROM cuentas c
      LEFT JOIN movimientos m ON m.cuenta_id = c.id
      GROUP BY c.id
      ORDER BY c.activa DESC, c.nombre`);
  }

  return { calcular, porCuenta };
}
