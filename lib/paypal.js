// PayPal Sandbox integration using the Orders v2 REST API (redirect flow).
// Docs: https://developer.paypal.com/docs/api/orders/v2/

const base = () => process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';

export const paypalConfigured = () =>
  Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

async function accessToken() {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch(`${base()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): check client id/secret`);
  return (await res.json()).access_token;
}

async function api(path, token, body, requestId) {
  const res = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.details?.[0]?.description || json.message || res.statusText;
    throw new Error(`PayPal ${res.status}: ${detail}`);
  }
  return json;
}

export async function createOrder({ referenceId, description, amount, currency, returnUrl, cancelUrl, payeeEmail }) {
  const token = await accessToken();
  const unit = {
    reference_id: referenceId,
    description: description.slice(0, 120),
    amount: { currency_code: currency, value: amount.toFixed(2) }
  };
  if (payeeEmail) unit.payee = { email_address: payeeEmail };

  const order = await api(
    '/v2/checkout/orders',
    token,
    {
      intent: 'CAPTURE',
      purchase_units: [unit],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'RELIEF-X AI',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: returnUrl,
            cancel_url: cancelUrl
          }
        }
      }
    },
    `${referenceId}-${Date.now()}`
  );

  const approveUrl = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  if (!approveUrl) throw new Error('PayPal did not return an approval link');
  return { paypalOrderId: order.id, approveUrl };
}

export async function captureOrder(paypalOrderId) {
  const token = await accessToken();
  const cap = await api(`/v2/checkout/orders/${paypalOrderId}/capture`, token, null, `cap-${paypalOrderId}`);
  const capture = cap.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    status: cap.status,
    captureId: capture?.id || null,
    amount: capture?.amount?.value || null,
    currency: capture?.amount?.currency_code || null
  };
}
