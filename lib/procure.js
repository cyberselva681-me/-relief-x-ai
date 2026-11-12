// Deterministic supplier matching. The AI proposes WHAT is needed; this module decides WHO can supply it.

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const money = (n) => Math.round(n * 100) / 100;

export function rankSuppliers(items, point, suppliers) {
  const rows = suppliers.map((s) => {
    const lines = items.map(({ sku, qty }) => {
      const stock = s.stock[sku] || 0;
      const fulfilled = Math.min(qty, stock);
      const price = s.prices[sku];
      return { sku, requested: qty, qty: fulfilled, price, lineTotal: money(fulfilled * price) };
    });
    const requested = lines.reduce((a, l) => a + l.requested, 0) || 1;
    const covered = lines.reduce((a, l) => a + l.qty, 0);
    return {
      supplier: s,
      lines,
      total: money(lines.reduce((a, l) => a + l.lineTotal, 0)),
      coverage: covered / requested,
      distanceKm: Math.round(distanceKm(point, s) * 10) / 10
    };
  });

  const maxDist = Math.max(...rows.map((r) => r.distanceKm)) || 1;
  const fullRows = rows.filter((r) => r.coverage >= 0.999);
  const pool = fullRows.length ? fullRows : rows;
  const minTotal = Math.min(...pool.map((r) => r.total)) || 1;

  for (const r of rows) {
    // Lower is better: cost 50%, distance 35%, rating 15%, heavy penalty for missing stock.
    r.score =
      0.5 * (r.total / minTotal) +
      0.35 * (r.distanceKm / maxDist) +
      0.15 * ((5 - r.supplier.rating) / 5) +
      10 * (1 - r.coverage);
    r.score = Math.round(r.score * 1000) / 1000;
  }
  return rows.sort((a, b) => a.score - b.score);
}
