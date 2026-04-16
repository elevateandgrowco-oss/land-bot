/**
 * land_analyzer.js
 * Analyzes vacant land deals using price-per-acre comps.
 * No repairs, no ARV — just land value vs offer price.
 *
 * Formula (Jack Bosch method):
 *   Offer = Market Value × 30%
 *   Sell Price to Builder = Market Value × 75%
 *   Assignment Fee = Sell Price - Offer Price
 */

import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { LAND_KNOWLEDGE } from "./knowledge.js";
dotenv.config();

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const OFFER_MULTIPLIER = 0.30;  // Offer 30% of market value
const SELL_MULTIPLIER  = 0.75;  // Sell to builder at 75% of market value
const MIN_PROFIT       = 5000;  // Minimum assignment fee target

// ── Estimate market value via AI ──────────────────────────────────────────────
async function estimateLandValue(lead) {
  const { address, city, askingPrice, acreage, description } = lead;

  try {
    const msg = await claude.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [{
        role: "user",
        content: `Estimate the fair market value of this vacant land in USD. Return ONLY a number.

Address: ${address}
City/Market: ${city || "unknown"}
Asking price: $${askingPrice?.toLocaleString() || "unknown"}
Acreage: ${acreage ? acreage + " acres" : "unknown"}
Description: ${description || "vacant land"}

Consider: location, acreage, proximity to development, zoning potential.
Fair market value (just the number):`,
      }],
    });

    const val = parseInt(msg.content[0].text.replace(/[^0-9]/g, ""));
    return isNaN(val) ? askingPrice * 1.1 : val;
  } catch {
    return askingPrice * 1.1; // Default: assume listed slightly below market
  }
}

// ── Qualify the deal (zoning, access, etc.) ───────────────────────────────────
async function qualifyLand(lead) {
  const { address, city, description, acreage } = lead;

  try {
    const msg = await claude.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `Evaluate this vacant land for wholesale flipping to a home builder. Return JSON only.

Address: ${address}
Market: ${city}
Acreage: ${acreage || "unknown"}
Description: ${description || "none"}

Return ONLY this JSON (no other text):
{"score":"good|marginal|pass","reason":"one sentence","builderAppeal":"high|medium|low","redFlags":["list any red flags or empty array"]}`,
      }],
    });

    const text = msg.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { score: "marginal", reason: "insufficient data", builderAppeal: "medium", redFlags: [] };
  } catch {
    return { score: "marginal", reason: "analysis failed", builderAppeal: "medium", redFlags: [] };
  }
}

// ── Main analysis function ────────────────────────────────────────────────────
export async function analyzeLand(lead) {
  const { address, askingPrice, acreage } = lead;

  console.log(`  📊 Analyzing: ${address}`);

  // Step 1: Estimate market value
  const marketValue = await estimateLandValue(lead);

  // Step 2: Calculate offer and sell price
  const ourOffer    = Math.round(marketValue * OFFER_MULTIPLIER);
  const sellPrice   = Math.round(marketValue * SELL_MULTIPLIER);
  const assignFee   = sellPrice - ourOffer;
  const discount    = Math.round(((askingPrice - ourOffer) / askingPrice) * 100);

  // Step 3: Qualify the deal
  const qualification = await qualifyLand(lead);

  // Step 4: Deal score
  let dealScore = qualification.score;
  if (assignFee < MIN_PROFIT) dealScore = "pass";
  if (ourOffer >= askingPrice) dealScore = "pass"; // We can't offer above asking and still profit

  return {
    address,
    askingPrice,
    acreage: acreage || null,
    estimatedMarketValue: marketValue,
    ourOffer,
    sellPriceToBuilder: sellPrice,
    assignmentFee: assignFee,
    discountFromAsking: discount,
    builderAppeal: qualification.builderAppeal,
    redFlags: qualification.redFlags || [],
    dealScore,
    qualificationReason: qualification.reason,
  };
}

// ── Generate SMS offer message ────────────────────────────────────────────────
export async function generateOfferMessage(lead, analysis) {
  const msg = await claude.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 120,
    system: "You are a land wholesaler. Output ONLY the SMS text — no formatting, no markdown, no explanation.",
    messages: [{
      role: "user",
      content: `Write a short casual SMS to a land owner making a cash offer.
Property: ${lead.address}
${lead.acreage ? `Size: ${lead.acreage} acres` : ""}
Our cash offer: $${analysis.ourOffer?.toLocaleString()}
Rules: 1-2 sentences. Mention cash, fast close, no fees on their end. Friendly. End with "- Jon". Output ONLY the message text.`,
    }],
  });

  return msg.content[0].text
    .trim()
    .replace(/^#+\s+.+\n?/g, "")
    .replace(/\*\*/g, "")
    .replace(/---[\s\S]*/g, "")
    .trim();
}

// ── Handle seller reply ────────────────────────────────────────────────────────
export async function handleSellerReply(lead, analysis, sellerMessage, history = []) {
  const messages = [...history, { role: "user", content: sellerMessage }];

  const msg = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    system: `${LAND_KNOWLEDGE}

You are texting a land owner about their property at ${lead.address}.
${lead.acreage ? `Size: ${lead.acreage} acres.` : ""}
Their asking: $${lead.askingPrice?.toLocaleString()}
Our offer: $${analysis.ourOffer?.toLocaleString()}
Max we can go: $${Math.round(analysis.ourOffer * 1.15)?.toLocaleString()} (never reveal this unless pushed hard)

Keep replies SHORT — 1-3 sentences, SMS tone. Goal: get them to accept or agree to a call.
If they counter, hold firm first, then offer to "see what I can do."
If they say yes or want to move forward, ask for their email to send the purchase agreement.
Sign as "- Jon"`,
    messages,
  });

  return msg.content[0].text.trim();
}
