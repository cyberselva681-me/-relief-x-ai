import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INCIDENTS, ITEMS, SUPPLIERS } from './lib/data.js';
import { estimateNeeds, explainChoice, liveWeather, aiStatus } from './lib/ai.js';
import { rankSuppliers } from './lib/procure.js';
import { createOrder, captureOrder, paypalConfigured } from './lib/paypal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'data', 'orders.json');
const CURRENCY = 'USD';
const CAP = Number(process.env.MAX_ORDER_USD || 5000);

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- tiny JSON "database" ----
const loadOrders = () => {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return [];
  }
};
const saveOrders = (orders) => {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2));
};
const findOrder = (orders, id) => orders.find((o) => o.id === id);
const log = (order, event) => order.history.push({ t: new Date().toISOString(), event });
const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
const round2 = (n) => Math.round(n * 100) / 100;

// ---- state for the dashboard ----
app.get('/api/state', (req, res) => {
  res.json({
    incidents: INCIDENTS,
    items: ITEMS,
    suppliers: SUPPLIERS.map(({ id, name, area, lat, lng, rating }) => ({ id, name, area, lat, lng, rating })),
    orders: loadOrders().reverse(),
    ai: aiStatus(),
    paypal: { configured: paypalConfigured(), env: 'sandbox' },
    guardrail: { maxOrderUsd: CAP, currency: CURRENCY }
  });
});

// ---- AI agent: incident -> needs -> supplier match -> PROPOSED order (no money moves) ----
app.post('/api/plan', async (req, res) => {
  const incident = INCIDENTS.find((i) => i.id === req.body?.incidentId);
  if (!incident) return res.status(404).json({ error: 'Unknown incident' });

  try {
    const weather = await liveWeather(incident.lat, incident.lng);
    const { needs, mode } = await estimateNeeds(incident, weather);
    const ranked = rankSuppliers(needs.items, incident, SUPPLIERS);
    const best = ranked[0];

    let lines = best.lines.filter((l) => l.qty > 0).map((l) => ({ ...l, name: ITEMS[l.sku].name }));
    let total = round2(lines.reduce((a, l) => a + l.lineTotal, 0));
    let capped = false;
    if (total > CAP) {
      const factor = CAP / total;
      lines = lines.map((l) => {
        const qty = Math.max(1, Math.floor(l.qty * factor));
        return { ...l, qty, lineTotal: round2(qty * l.price) };
      });
      total = round2(lines.reduce((a, l) => a + l.lineTotal, 0));
      capped = true;
    }

    const rationale = await explainChoice({
      incident,
      best: { ...best, total },
      others: ranked.slice(1),
      capped,
      cap: CAP
    });

    const order = {
      id: `RX-${Date.now().toString(36).toUpperCase()}`,
      incidentId: incident.id,
      incidentName: `${incident.area} - ${incident.type}`,
      createdAt: new Date().toISOString(),
      status: 'proposed',
      aiMode: mode,
      weather,
      needs,
      supplier: {
        id: best.supplier.id,
        name: best.supplier.name,
        area: best.supplier.area,
        rating: best.supplier.rating,
        distanceKm: best.distanceKm
      },
      alternatives: ranked.slice(1).map((r) => ({
        name: r.supplier.name,
        distanceKm: r.distanceKm,
        total: r.total,
        coveragePct: Math.round(r.coverage * 100)
      })),
      lines,
      total,
      currency: CURRENCY,
      budgetCapped: capped,
      rationale,
      paypal: null,
      history: []
    };
    log(order, `AI agent proposed order from ${order.supplier.name} (${mode === 'gemini' ? 'Gemini' : 'rule-based'} estimate)`);

    const orders = loadOrders();
    orders.push(order);
    saveOrders(orders);
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Human approval -> create PayPal Sandbox order ----
app.post('/api/orders/:id/approve', async (req, res) => {
  const orders = loadOrders();
  const order = findOrder(orders, req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['proposed', 'payment_cancelled'].includes(order.status)) {
    return res.status(409).json({ error: `Order is already ${order.status}` });
  }
  if (!paypalConfigured()) {
    return res.status(400).json({ error: 'PayPal Sandbox credentials are not configured (see README).' });
  }

  try {
    const root = baseUrl(req);
    const { paypalOrderId, approveUrl } = await createOrder({
      referenceId: order.id,
      description: `RELIEF-X ${order.incidentName} - ${order.supplier.name}`,
      amount: order.total,
      currency: order.currency,
      returnUrl: `${root}/paypal/return`,
      cancelUrl: `${root}/paypal/cancel`,
      payeeEmail: process.env.SUPPLIER_PAYEE_EMAIL || undefined
    });
    order.status = 'awaiting_payment';
    order.paypal = { orderId: paypalOrderId, status: 'CREATED' };
    log(order, 'Human approved. PayPal Sandbox order created, awaiting payer approval');
    saveOrders(orders);
    res.json({ approveUrl });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/orders/:id/reject', (req, res) => {
  const orders = loadOrders();
  const order = findOrder(orders, req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'proposed') return res.status(409).json({ error: `Order is already ${order.status}` });
  order.status = 'rejected';
  log(order, 'Human rejected the proposal. No payment made');
  saveOrders(orders);
  res.json(order);
});

// ---- PayPal redirects back here after the payer approves ----
app.get('/paypal/return', async (req, res) => {
  const paypalOrderId = req.query.token;
  const orders = loadOrders();
  const order = orders.find((o) => o.paypal?.orderId === paypalOrderId);
  if (!order) return res.redirect('/?error=' + encodeURIComponent('Unknown PayPal order'));
  try {
    const cap = await captureOrder(paypalOrderId);
    order.paypal = { ...order.paypal, status: cap.status, captureId: cap.captureId };
    if (cap.status === 'COMPLETED') {
      order.status = 'paid';
      log(order, `Payment captured via PayPal Sandbox (capture ${cap.captureId})`);
    } else {
      log(order, `PayPal capture returned status ${cap.status}`);
    }
    saveOrders(orders);
    res.redirect(`/?paid=${order.id}`);
  } catch (err) {
    console.error(err);
    res.redirect('/?error=' + encodeURIComponent(err.message));
  }
});

app.get('/paypal/cancel', (req, res) => {
  const paypalOrderId = req.query.token;
  const orders = loadOrders();
  const order = orders.find((o) => o.paypal?.orderId === paypalOrderId);
  if (order && order.status === 'awaiting_payment') {
    order.status = 'payment_cancelled';
    log(order, 'Payer cancelled at PayPal. Order can be approved again');
    saveOrders(orders);
  }
  res.redirect('/?cancelled=1');
});

// ---- Delivery tracking (SIMULATED; there are no real suppliers) ----
const NEXT = { paid: 'dispatched', dispatched: 'delivered' };
app.post('/api/orders/:id/advance', (req, res) => {
  const orders = loadOrders();
  const order = findOrder(orders, req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const next = NEXT[order.status];
  if (!next) return res.status(409).json({ error: `Cannot advance from ${order.status}` });
  order.status = next;
  log(order, `Delivery status updated to ${next} (simulated)`);
  saveOrders(orders);
  res.json(order);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  const ai = aiStatus();
  console.log(`RELIEF-X AI running on http://localhost:${port}`);
  console.log(`  AI:     ${ai.mode === 'gemini' ? `Gemini (${ai.model})` : 'rule-based fallback (set GEMINI_API_KEY)'}`);
  console.log(`  PayPal: ${paypalConfigured() ? 'sandbox credentials found' : 'NOT configured (set PAYPAL_CLIENT_ID / SECRET)'}`);
});
