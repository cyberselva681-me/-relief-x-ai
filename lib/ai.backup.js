
// AI layer: Google Gemini estimates relief needs and explains procurement choices.
// Uses a rule-based fallback whenever Gemini is unavailable.

import { ITEMS } from './data.js';

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const hasKey = () => Boolean(process.env.GEMINI_API_KEY);

export function aiStatus() {
  return hasKey()
    ? { mode: 'gemini', model: MODEL() }
    : { mode: 'heuristic', model: null };
}

// Gemini API call with retry handling for temporary server errors.
async function callGemini(system, user, maxTokens = 900, jsonMode = false) {
  if (!hasKey()) {
    throw new Error('GEMINI_API_KEY is missing');
  }

  const model = MODEL();
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[RELIEF-X] Gemini attempt ${attempt}/${maxAttempts}`);

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: system }]
            },
            contents: [
              {
                role: 'user',
                parts: [{ text: user }]
              }
            ],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: maxTokens,
              ...(jsonMode
                ? { responseMimeType: 'application/json' }
                : {})
            }
          }),
          signal: AbortSignal.timeout(30000)
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(
          `Gemini API ${response.status}: ${errorText.slice(0, 300)}`
        );
        error.status = response.status;
        throw error;
      }

      const result = await response.json();

      const text = result.candidates?.[0]?.content?.parts
        ?.map(part => part.text || '')
        .join('');

      if (!text) {
        throw new Error('Gemini returned an empty response');
      }

      console.log('[RELIEF-X] Gemini request successful.');
      return text;

    } catch (error) {
      const retryable =
        [429, 500, 502, 503, 504].includes(error.status) ||
        error.name === 'TimeoutError';

      if (!retryable || attempt === maxAttempts) {
        throw error;
      }

      const delay = attempt * 3000;

      console.log(
        `[RELIEF-X] Gemini temporarily unavailable. Retrying in ${delay / 1000}s...`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Gemini request failed after retries');
}

// Extract JSON safely from model output.
function extractJson(text) {
  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No valid JSON found in Gemini response');
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

// Live weather context from Open-Meteo (free, no API key).
export async function liveWeather(lat, lng) {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}` +
      `&longitude=${lng}` +
      '&hourly=precipitation_probability' +
      '&daily=precipitation_sum' +
      '&forecast_days=2&timezone=auto';

    const response = await fetch(url, {
      signal: AbortSignal.timeout(4000)
    });

    if (!response.ok) return null;

    const data = await response.json();

    return {
      forecastPrecipitationMm: data.daily?.precipitation_sum ?? null,
      peakPrecipProbability: Math.max(
        ...(data.hourly?.precipitation_probability ?? [0])
      )
    };

  } catch {
    return null;
  }
}

// Validate item SKUs and quantities against the available catalog.
function clampItems(items) {
  const clean = [];

  for (const item of items || []) {
    if (!ITEMS[item.sku]) continue;

    const qty = Math.max(
      0,
      Math.min(2000, Math.round(Number(item.qty) || 0))
    );

    if (qty > 0) {
      clean.push({
        sku: item.sku,
        qty
      });
    }
  }

  return clean;
}

// Rule-based fallback when Gemini is unavailable.
function heuristicNeeds(incident) {
  const households = Math.max(
    1,
    Math.round(
      (Number(incident.reports) || 0) * 5 +
      (Number(incident.waterLevelCm) || 0) * 1.5
    )
  );

  const severity = Math.max(
    1,
    Math.min(
      5,
      Math.round(
        (Number(incident.rainfall24hMm) || 0) / 35 +
        (Number(incident.waterLevelCm) || 0) / 40
      )
    )
  );

  const suggestedItems = [
    { sku: 'water_pack', qty: households },
    { sku: 'food_kit', qty: households },
    { sku: 'first_aid_kit', qty: Math.ceil(households / 10) },
    {
      sku: 'blanket',
      qty: severity >= 4
        ? households
        : Math.ceil(households / 2)
    }
  ];

  return {
    severity,
    households,
    items: clampItems(suggestedItems),
    reasoning:
      'Rule-based estimate: households are scaled from incident reports and water level. ' +
      'Water and food are estimated per household, with first-aid kits allocated per 10 households. ' +
      'Blanket quantities increase with incident severity.'
  };
}

// Estimate relief needs using Gemini, with automatic fallback.
export async function estimateNeeds(incident, weather) {
  if (!hasKey()) {
    return {
      needs: heuristicNeeds(incident),
      mode: 'heuristic'
    };
  }

  const catalog = Object.entries(ITEMS)
    .map(([sku, item]) => `- ${sku}: ${item.name}`)
    .join('\n');

  const system =
    'You are the planning module of an urban emergency relief system. ' +
    'Estimate relief requirements from incident data. Be conservative, realistic, and safety-focused. ' +
    'Respond with ONLY a valid JSON object. Do not include markdown.';

  const user = `Incident:
${JSON.stringify(incident, null, 2)}

Live forecast context:
${JSON.stringify(weather)}

Available relief items:
${catalog}

Return JSON exactly in this shape:
{
  "severity": 1,
  "households": 100,
  "items": [
    { "sku": "water_pack", "qty": 100 }
  ],
  "reasoning": "Explain the estimate in 2-3 sentences."
}`;

  try {
    const response = await callGemini(system, user, 900, true);
    const parsed = extractJson(response);

    const items = clampItems(parsed.items);

    if (!items.length) {
      throw new Error('Gemini returned no valid catalog items');
    }

    return {
      needs: {
        severity: Math.max(
          1,
          Math.min(5, Math.round(Number(parsed.severity) || 3))
        ),
        households: Math.max(
          1,
          Math.round(Number(parsed.households) || 1)
        ),
        items,
        reasoning: String(parsed.reasoning || '').slice(0, 800)
      },
      mode: 'gemini'
    };

  } catch (error) {
    console.error(
      '[RELIEF-X] Gemini needs estimation failed. Using heuristic:',
      error.message
    );

    const needs = heuristicNeeds(incident);

    needs.reasoning =
      `Gemini unavailable (${error.message.slice(0, 100)}). ` +
      needs.reasoning;

    return {
      needs,
      mode: 'heuristic'
    };
  }
}

// Explain why a particular supplier was selected.
export async function explainChoice({
  incident,
  best,
  others,
  capped,
  cap
}) {
  const fallback =
    `${best.supplier.name} is the best overall match: ` +
    `${best.distanceKm} km from ${incident.area}, ` +
    `rated ${best.supplier.rating}, total $${best.total.toFixed(2)}.` +
    (capped
      ? ` Quantities were scaled down to respect the $${cap} spending guardrail.`
      : '');

  if (!hasKey()) return fallback;

  const system =
    'You are a procurement agent for emergency relief. ' +
    'Write a short, plain justification of no more than 3 sentences. ' +
    'Mention price, distance, stock availability, and trade-offs. ' +
    'Do not use markdown. Do not invent facts.';

  const user = JSON.stringify({
    incident: incident.area,
    chosen: {
      name: best.supplier.name,
      distanceKm: best.distanceKm,
      rating: best.supplier.rating,
      total: best.total,
      coverage: best.coverage
    },
    alternatives: others.map(other => ({
      name: other.supplier.name,
      distanceKm: other.distanceKm,
      total: other.total,
      coverage: Math.round(other.coverage * 100) / 100
    })),
    spendingCapApplied: capped,
    spendingCap: cap
  });

  try {
    return (
      await callGemini(system, user, 300)
    ).trim() || fallback;

  } catch (error) {
    console.error(
      '[RELIEF-X] Gemini procurement explanation failed:',
      error.message
    );

    return fallback;
  }
}
