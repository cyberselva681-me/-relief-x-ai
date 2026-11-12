# RELIEF-X AI

**An AI agent that turns urban emergency signals into a proposed relief order, and pays for it through PayPal after a human approves.**

Built for the *Build What's Next with PayPal and AI* hackathon.

When a city floods, relief teams lose hours turning "what is happening" into "what do we buy, from whom, and how do we pay". RELIEF-X AI compresses that into one flow:

1. **Detect.** An incident from the early-warning feed appears on a live map.
2. **Understand.** Claude estimates severity, affected households and the relief items needed, using the incident data plus a live rainfall forecast (Open-Meteo).
3. **Procure.** A matching engine compares suppliers on price, distance, rating and stock. Claude explains the choice in plain language.
4. **Approve.** The agent only *proposes* an order. A human reviews it and clicks Approve. A per-order spending cap is enforced in code.
5. **Pay.** PayPal Sandbox (Orders v2 API) creates the order, the approver pays at PayPal, and the app captures the payment.
6. **Track.** The dashboard shows every order, its PayPal capture ID and an audit trail of each step.

## Honest scope notes

- **Incidents are sample data** (`lib/data.js`) that stands in for the output of an urban early-warning system.
- **Suppliers are fictional.** Prices and stock are seeded demo values.
- **Delivery progress is simulated.** The "Mark dispatched / delivered" buttons only update status; no real logistics exist.
- **Payments are PayPal Sandbox only.** No real money moves.

## How PayPal is used

| Step | PayPal API |
|------|-----------|
| Agent's order is approved by a human | `POST /v2/checkout/orders` (intent `CAPTURE`, redirect flow with return/cancel URLs) |
| Approver pays at PayPal | PayPal-hosted approval page (sandbox buyer account) |
| Payment is finalised | `POST /v2/checkout/orders/{id}/capture` |
| Dashboard status | Capture ID and status stored per order |

PayPal is the settlement step of the agent's workflow, not a bolt-on button: the agent builds a priced, itemised order and the PayPal order is created from exactly that proposal. Requests use `PayPal-Request-Id` for idempotency, and cancelled payments can be re-approved.

## How AI is used

| Where | Model | What it does |
|-------|-------|--------------|
| `lib/ai.js` `estimateNeeds` | Anthropic Claude (`claude-sonnet-5-5` by default, set with `AI_MODEL`) | Reads the incident and forecast and returns structured JSON: severity (1-5), affected households, item quantities and reasoning. Output is validated and clamped. |
| `lib/ai.js` `explainChoice` | Anthropic Claude | Writes a short justification for the chosen supplier, covering price, distance, stock and trade-offs. |
| `lib/procure.js` | Deterministic code | Ranks suppliers by weighted cost, distance, rating and stock coverage. The model decides *what* is needed; code decides *who* supplies it and checks the money. |

If no `ANTHROPIC_API_KEY` is set, or a call fails, the app falls back to a rule-based estimator and says so in the UI (an amber "rule-based" tag), so a judge always knows which path ran.

### Guardrails for an agent that moves money

- The agent never pays. It only proposes; a human must click Approve.
- Orders above `MAX_ORDER_USD` (default 5000) are scaled down before they reach the human.
- Model output is parsed as JSON, restricted to known SKUs and capped in quantity.
- Every state change is written to the order's audit trail.

## Run it locally

Requires Node 18 or newer.

```bash
git clone <your-repo-url>
cd relief-x-ai
npm install
cp .env.example .env     # then fill in the keys below
npm start                # http://localhost:3000
```

### Configuration (`.env`)

| Variable | Required | Notes |
|----------|----------|-------|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | For payments | From a Sandbox app at https://developer.paypal.com/dashboard/applications/sandbox |
| `SUPPLIER_PAYEE_EMAIL` | Optional | Sandbox business account email that receives the payment. If empty, the app's own sandbox merchant receives it. |
| `ANTHROPIC_API_KEY` | For Claude | Without it, the rule-based fallback is used. |
| `AI_MODEL` | Optional | Defaults to `claude-sonnet-5-5`. |
| `MAX_ORDER_USD` | Optional | Per-order spending cap. Default 5000. |
| `BASE_URL` | When deployed | Your public URL, used for PayPal return links. |
| `PORT` | Optional | Default 3000. |

### Try the demo flow

1. Open the app and click the **Bellandur** incident.
2. Click **Run AI agent**. Review the needs estimate, the proposed order and the supplier reasoning.
3. Click **Approve & pay with PayPal**.
4. Log in with a **sandbox personal (buyer) account** from the PayPal developer dashboard and approve the payment.
5. You return to the dashboard with the order marked **paid** and a PayPal capture ID.
6. Use the delivery buttons to walk the order through dispatched and delivered (simulated).

## Deploy on Render

A `render.yaml` blueprint is included. Create a new Web Service from the repo, set the environment variables above (including `BASE_URL` set to your Render URL), and deploy. Orders are stored in a local JSON file (`data/orders.json`), which resets when Render restarts the instance. That is fine for a demo.

## Project layout

```
server.js        Express API, order state machine, PayPal return/cancel routes
lib/ai.js        Claude calls, forecast lookup, rule-based fallback
lib/procure.js   Supplier ranking
lib/paypal.js    PayPal Orders v2 client (create and capture)
lib/data.js      Sample incidents, items and fictional suppliers
public/          Command-center dashboard (vanilla JS, Leaflet map)
```

## Tech

Node.js, Express, vanilla JS, Leaflet and OpenStreetMap tiles, Open-Meteo forecast API, Anthropic Claude API, PayPal Orders v2 (Sandbox).

## License

MIT. See [LICENSE](LICENSE).
