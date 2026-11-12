const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => `$${Number(n).toFixed(2)}`;

let state = null;
let selected = null;
let currentOrderId = null;
let map, markers = {};

async function api(url, opts) {
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function banner(kind, text) {
  const el = $('#banner');
  el.className = `banner ${kind}`;
  el.textContent = text;
}

const sevClass = (i) => {
  const score = i.rainfall24hMm / 35 + i.waterLevelCm / 40;
  return score >= 3.5 ? 'sev-hi' : score >= 2 ? 'sev-md' : 'sev-lo';
};
const sevLabel = (c) => ({ 'sev-hi': 'HIGH', 'sev-md': 'MEDIUM', 'sev-lo': 'LOW' }[c]);
const sevColor = (c) => ({ 'sev-hi': '#ef4444', 'sev-md': '#f59e0b', 'sev-lo': '#34d399' }[c]);

function renderChips() {
  const ai = $('#chip-ai');
  if (state.ai.mode && state.ai.mode !== 'heuristic') {
    ai.textContent = `AI: ${state.ai.provider || 'Gemini'}${state.ai.model ? ' (' + state.ai.model + ')' : ''}`;
    ai.className = 'chip ok';
  } else {
    ai.textContent = 'AI: rule-based fallback (no API key)';
    ai.className = 'chip warn';
  }
  const pp = $('#chip-pp');
  pp.textContent = state.paypal.configured ? 'PayPal: Sandbox connected' : 'PayPal: not configured';
  pp.className = state.paypal.configured ? 'chip ok' : 'chip warn';
  $('#chip-cap').textContent = `Spend guardrail: ${usd(state.guardrail.maxOrderUsd)} per order`;
}

function renderMap() {
  if (!map) {
    map = L.map('map', { zoomControl: true }).setView([12.97, 77.62], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18
    }).addTo(map);
    state.suppliers.forEach((s) =>
      L.circleMarker([s.lat, s.lng], { radius: 6, color: '#3da5ff', fillColor: '#3da5ff', fillOpacity: 0.8 })
        .addTo(map)
        .bindTooltip(`Supplier: ${s.name}`)
    );
  }
  Object.values(markers).forEach((m) => m.remove());
  markers = {};
  state.incidents.forEach((i) => {
    const c = sevColor(sevClass(i));
    markers[i.id] = L.circle([i.lat, i.lng], {
      radius: 900 + i.reports * 40,
      color: c,
      fillColor: c,
      fillOpacity: i.id === selected ? 0.5 : 0.3,
      weight: i.id === selected ? 3 : 1
    })
      .addTo(map)
      .bindTooltip(`${i.area}: ${i.type}`)
      .on('click', () => select(i.id));
  });
}

function renderIncidents() {
  $('#incidents').innerHTML = state.incidents
    .map((i) => {
      const c = sevClass(i);
      return `<li class="incident ${i.id === selected ? 'sel' : ''}" data-id="${esc(i.id)}">
        <div><b>${esc(i.area)} &middot; ${esc(i.type)}</b>
        <span>${i.rainfall24hMm} mm / 24h &middot; water ${i.waterLevelCm} cm &middot; ${i.reports} reports</span></div>
        <span class="sev ${c}">${sevLabel(c)}</span></li>`;
    })
    .join('');
  document.querySelectorAll('.incident').forEach((el) => el.addEventListener('click', () => select(el.dataset.id)));
}

function select(id) {
  selected = id;
  renderIncidents();
  renderMap();
  renderAgent();
}

function renderAgent() {
  const inc = state.incidents.find((i) => i.id === selected);
  const order = state.orders.find((o) => o.id === currentOrderId);
  const showOrder = order && order.incidentId === selected;
  $('#agent-empty').classList.toggle('hidden', Boolean(inc));
  $('#agent').classList.toggle('hidden', !inc);
  if (!inc) return;

  let html = `<div class="run-row">
      <button class="primary" id="run">Run AI agent for ${esc(inc.area)}</button>
      <span style="color:var(--muted);font-size:12px">${esc(inc.notes)}</span>
    </div>`;

  if (showOrder) {
    const fallback = !order.aiMode || order.aiMode === 'heuristic';
    html += `
    <ul class="steps">
      <li>Incident analysed${order.weather ? ' with live forecast data (Open-Meteo)' : ''}</li>
      <li>Relief needs estimated <span class="tag ${fallback ? 'fallback' : ''}">${fallback ? 'rule-based' : esc((state.ai && state.ai.provider) || 'Gemini')}</span></li>
      <li>${state.suppliers.length} suppliers compared on price, distance, rating and stock</li>
      <li>Order proposed. Waiting for human approval</li>
    </ul>
    <div class="card"><h3>Needs estimate &middot; severity ${order.needs.severity}/5 &middot; ~${order.needs.households} households</h3>
      <p>${esc(order.needs.reasoning)}</p></div>
    <div class="card"><h3>Proposed order ${esc(order.id)}</h3>
      <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th></tr></thead><tbody>
      ${order.lines
        .map(
          (l) => `<tr><td>${esc(l.name)}${l.qty < l.requested ? ` <span class="tag fallback">stock limit</span>` : ''}</td>
          <td class="num">${l.qty}</td><td class="num">${usd(l.price)}</td><td class="num">${usd(l.lineTotal)}</td></tr>`
        )
        .join('')}
      <tr><td colspan="3"><b>Total (${esc(order.currency)})</b>${order.budgetCapped ? ' <span class="tag fallback">scaled to spend guardrail</span>' : ''}</td>
      <td class="num"><b>${usd(order.total)}</b></td></tr></tbody></table></div>
    <div class="card"><h3>Supplier: ${esc(order.supplier.name)} &middot; ${order.supplier.distanceKm} km &middot; rated ${order.supplier.rating}</h3>
      <p>${esc(order.rationale)}</p>
      <div class="hist">Compared: ${order.alternatives
        .map((a) => `${esc(a.name)} (${usd(a.total)}, ${a.distanceKm} km, ${a.coveragePct}% stock)`)
        .join(' &middot; ')}</div></div>`;
    if (['proposed', 'payment_cancelled'].includes(order.status)) {
      html += `<div class="run-row">
        <button class="pay" id="approve">Approve &amp; pay ${usd(order.total)} with PayPal</button>
        <button class="ghost" id="reject">Reject</button></div>`;
    } else {
      html += `<div class="run-row"><span class="status st-${esc(order.status)}">${esc(order.status.replace('_', ' '))}</span></div>`;
    }
  }
  $('#agent').innerHTML = html;

  $('#run').addEventListener('click', runAgent);
  const ap = $('#approve');
  if (ap) ap.addEventListener('click', () => approve(order.id));
  const rj = $('#reject');
  if (rj) rj.addEventListener('click', () => reject(order.id));
}

async function runAgent() {
  const btn = $('#run');
  btn.disabled = true;
  btn.textContent = 'Agent working...';
  try {
    const order = await api('/api/plan', { method: 'POST', body: JSON.stringify({ incidentId: selected }) });
    currentOrderId = order.id;
    await refresh();
  } catch (e) {
    banner('err', e.message);
    btn.disabled = false;
    btn.textContent = 'Run AI agent again';
  }
}

async function approve(id) {
  const btn = $('#approve');
  btn.disabled = true;
  btn.textContent = 'Contacting PayPal...';
  try {
    const { approveUrl } = await api(`/api/orders/${id}/approve`, { method: 'POST' });
    window.location.href = approveUrl;
  } catch (e) {
    banner('err', e.message);
    btn.disabled = false;
    btn.textContent = 'Retry approve & pay';
  }
}

async function reject(id) {
  try {
    await api(`/api/orders/${id}/reject`, { method: 'POST' });
    await refresh();
  } catch (e) {
    banner('err', e.message);
  }
}

async function advance(id) {
  try {
    await api(`/api/orders/${id}/advance`, { method: 'POST' });
    await refresh();
  } catch (e) {
    banner('err', e.message);
  }
}

const NEXT_LABEL = { paid: 'Mark dispatched', dispatched: 'Mark delivered' };

function renderOrders() {
  const body = $('#orders');
  if (!state.orders.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty">No orders yet.</td></tr>`;
    return;
  }
  body.innerHTML = state.orders
    .map((o) => {
      const last = o.history[o.history.length - 1];
      return `<tr>
        <td><b>${esc(o.id)}</b><div class="hist">${esc(new Date(o.createdAt).toLocaleString())}</div></td>
        <td>${esc(o.incidentName)}</td>
        <td>${esc(o.supplier.name)}</td>
        <td>${usd(o.total)}</td>
        <td><span class="status st-${esc(o.status)}">${esc(o.status.replace('_', ' '))}</span>
          ${o.paypal?.captureId ? `<div class="hist">PayPal capture ${esc(o.paypal.captureId)}</div>` : ''}
          ${last ? `<div class="hist">${esc(last.event)}</div>` : ''}</td>
        <td>${NEXT_LABEL[o.status] ? `<button class="small" data-adv="${esc(o.id)}">${NEXT_LABEL[o.status]}</button>` : ''}</td>
      </tr>`;
    })
    .join('');
  document.querySelectorAll('[data-adv]').forEach((b) => b.addEventListener('click', () => advance(b.dataset.adv)));
}

async function refresh() {
  state = await api('/api/state');
  renderChips();
  renderIncidents();
  renderMap();
  renderAgent();
  renderOrders();
}

(async function init() {
  await refresh();
  const q = new URLSearchParams(location.search);
  if (q.get('paid')) {
    const o = state.orders.find((x) => x.id === q.get('paid'));
    currentOrderId = q.get('paid');
    if (o) selected = o.incidentId;
    banner('ok', `Payment captured in PayPal Sandbox for order ${q.get('paid')}.`);
    renderIncidents(); renderMap(); renderAgent();
  } else if (q.get('cancelled')) {
    banner('info', 'Payment was cancelled at PayPal. The order is still open; you can approve it again.');
  } else if (q.get('error')) {
    banner('err', q.get('error'));
  }
  if (q.toString()) history.replaceState({}, '', '/');
})();
