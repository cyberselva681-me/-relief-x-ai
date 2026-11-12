
// RELIEF-X AI Layer
// Google Gemini Interactions API + rule-based fallback.

import { GoogleGenAI } from '@google/genai';
import { ITEMS } from './data.js';

const MODEL = () =>
  process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const hasKey = () => Boolean(process.env.GEMINI_API_KEY);

function getClient() {
  if (!hasKey()) {
    throw new Error('GEMINI_API_KEY is missing');
  }

  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });
}

export function aiStatus() {
  return hasKey()
    ? { mode: 'gemini', model: MODEL() }
    : { mode: 'heuristic', model: null };
}

// Gemini Interactions API with retry handling.
async function callGemini(system, user, maxTokens = 900) {
  const ai = getClient();
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(
        `[RELIEF-X] Gemini Interactions attempt ${attempt}/${maxAttempts}`
      );

      const response = await ai.interactions.create({
        model: MODEL(),
        system_instruction: system,
        input: user,
        generation_config: {
          temperature: 0.3,
          max_output_tokens: maxTokens
        }
      });

      const text = response.output_text?.trim();

      if (!text) {
        throw new Error('Gemini returned an empty response');
      }

      console.log('[RELIEF-X] Gemini response successful.');

      return text;

    } catch (error) {
      const status = error.status || error.code;

      const retryable =
        [408, 429, 500, 502, 503, 504].includes(Number(status)) ||
        ['TimeoutError', 'ECONNRESET', 'ETIMEDOUT'].includes(
          error.code || error.name
        );

      if (!retryable || attempt === maxAttempts) {
        throw error;
      }

      const delay = attempt * 3000;

      console.log(
        `[RELIEF-X] Gemini temporarily unavailable. ` +
        `Retrying in ${delay / 1000}s...`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Gemini failed after retries');
}

// Safely extract JSON from Gemini output.
function extractJson(text) {
  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start === -1 || end <= start) {
    throw new Error('No valid JSON found in Gemini response');
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

// Live weather context from Open-Meteo.
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
      forecastPrecipitationMm:
        data.daily?.precipitation_sum ?? null,

      peakPrecipProbability: Math.max(
        ...(data.hourly?.precipitation_probability ?? [0])
      )
    };

  } catch {
    return null;
  }
}

// Validate relief item SKUs and quantities.
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

// Rule-based fallback.
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

  return {
    severity,
    households,

    items: clampItems([
      { sku: 'water_pack', qty: households },
      { sku: 'food_kit', qty: households },
      {
        sku: 'first_aid_kit',
        qty: Math.ceil(households / 10)
      },
      {
        sku: 'blanket',
        qty: severity >= 4
          ? households
          : Math.ceil(households / 2)
      }
    ]),

    reasoning:
      'Rule-based estimate: households are scaled from incident reports ' +
      'and water level. Water and food are estimated per household, ' +
      'with first-aid kits allocated per 10 households. ' +
      'Blanket quantities increase with incident severity.'
  };
}

// Gemini-powered relief demand estimation.
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
    'You are the planning module of RELIEF-X, an urban emergency relief system. ' +
    'Estimate relief requirements using incident information and weather. ' +
    'Be conservative, realistic and safety-focused. ' +
    'Never invent measurements. ' +
    'Return ONLY a valid JSON object without markdown.';

  const user = `Incident:
${JSON.stringify(incident, null, 2)}

Live weather:
${JSON.stringify(weather)}

Available relief items:
${catalog}

Estimate the affected households, incident severity from 1 to 5,
and appropriate relief item quantities.

Return JSON in this exact structure:
{
  "severity": 1,
  "households": 100,
  "items": [
    {
      "sku": "water_pack",
      "qty": 100
    }
  ],
  "reasoning": "Explain the estimate in 2-3 sentences."
}

Only use SKUs from the supplied catalog.
Quantities must be non-negative integers.
Do not exceed 2000 units per item.`;

  try {
    const response = await callGemini(system, user, 900);
    const parsed = extractJson(response);

    const items = clampItems(parsed.items);

    if (!items.length) {
      throw new Error('Gemini returned no valid catalog items');
    }

    const severity = Math.max(
      1,
      Math.min(5, Math.round(Number(parsed.severity) || 3))
    );

    const households = Math.max(
      1,
      Math.min(100000, Math.round(Number(parsed.households) || 1))
    );

    return {
      needs: {
        severity,
        households,
        items,
        reasoning: String(parsed.reasoning || '')
          .slice(0, 800)
      },
      mode: 'gemini'
    };

  } catch (error) {
    console.error(
      '[RELIEF-X] Gemini estimation failed. Using heuristic:',
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

// Gemini-powered supplier selection explanation.
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
    'You are the procurement intelligence module of RELIEF-X. ' +
    'Explain the selected emergency relief supplier in no more than 3 sentences. ' +
    'Mention price, distance, available stock and trade-offs. ' +
    'Use only supplied information. Do not invent facts. ' +
    'Do not use markdown.';

  const user = JSON.stringify({
    incident: incident.area,

    selectedSupplier: {
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
      '[RELIEF-X] Supplier explanation failed:',
      error.message
    );

    return fallback;
  }
}
