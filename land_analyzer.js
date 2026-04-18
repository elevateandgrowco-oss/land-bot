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
const MIN_PROFIT       = 3000;  // Minimum assignment fee target (lowered to catch more rural deals)

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
  // For tax delinquent/no-asking-price leads, discount is vs market value
  const basePrice   = askingPrice > 0 ? askingPrice : marketValue;
  const discount    = basePrice > 0 ? Math.round(((basePrice - ourOffer) / basePrice) * 100) : 0;

  // Step 3: Qualify the deal
  const qualification = await qualifyLand(lead);

  // Step 4: Deal score
  let dealScore = qualification.score;
  if (assignFee < MIN_PROFIT) dealScore = "pass";
  // For tax delinquent leads (askingPrice = 0), don't apply the "offer >= asking" check
  if (askingPrice > 0 && ourOffer >= askingPrice) dealScore = "pass"; // We can't offer above asking and still profit

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
  const isTaxDelinquent = (lead.source || "").toLowerCase().includes("tax") || (lead.motivation || "").toLowerCase().includes("tax");
  const isInherited = (lead.description || "").toLowerCase().includes("inherit") ||
                      (lead.source || "").toLowerCase().includes("probate");
  const isGov = (lead.source || "").includes("gov_surplus") || (lead.source || "").includes("auction");

  const isNearConstruction = lead.nearConstruction;

  let contextHint = "";
  if (isNearConstruction) {
    contextHint = `This owner has a vacant lot in an active builder corridor (TX/FL/NC/TN). New homes are being built nearby. Open with something that hints at activity in the area without being pushy — like: "I'm buying lots in your area — there's a lot of new development going in and I'm looking to move on something quickly."`;
  } else if (isTaxDelinquent) {
    contextHint = `This seller has past-due property taxes. Open with something like: "I noticed the county has your property listed with past-due taxes — I'm a cash buyer and might be able to help you get out before the county takes action."`;
  } else if (isInherited) {
    contextHint = `This appears to be inherited land. Be empathetic — acknowledge it may have sentimental value but pivot to the practical benefit of getting cash now.`;
  } else if (isGov) {
    contextHint = `This is a government auction or surplus land listing. The seller is motivated and deadline-driven — emphasize fast close.`;
  }

  const msg = await claude.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    system: "You are a land wholesaler. Output ONLY the SMS text — no formatting, no markdown, no explanation.",
    messages: [{
      role: "user",
      content: `Write a short casual opening SMS to a land owner to start a conversation about buying their land.
Property: ${lead.address}
${lead.acreage ? `Size: ${lead.acreage} acres` : ""}
Our cash offer: $${analysis.ourOffer?.toLocaleString()}
${contextHint}
Rules: 1-3 sentences max. Mention cash and fast close. Do NOT dump the full offer price in the first message — just open the door. Friendly, conversational, no pressure. End with "- Jon". Output ONLY the message text.`,
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

  const isTaxDelinquent = (lead.source || "").toLowerCase().includes("tax") || (lead.motivation || "").toLowerCase().includes("tax");

  // Owner financing sell price = 3x our offer (Brent Bowers method)
  const ownerFinanceSellPrice = analysis.ourOffer ? analysis.ourOffer * 3 : null;
  const ownerFinanceMonthly = ownerFinanceSellPrice ? Math.round(ownerFinanceSellPrice / 60) : null; // 5-year note
  const ownerFinanceDown = ownerFinanceSellPrice ? Math.round(ownerFinanceSellPrice * 0.15) : null;

  const msg = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 220,
    system: `${LAND_KNOWLEDGE}

You are texting a land owner about their property at ${lead.address}.
${lead.acreage ? `Size: ${lead.acreage} acres.` : ""}
Their asking: $${lead.askingPrice?.toLocaleString() || "not specified"}
Our cash offer: $${analysis.ourOffer?.toLocaleString() || "TBD"}
Max we can go (cash): $${Math.round((analysis.ourOffer || 0) * 1.15).toLocaleString()} — never reveal unless they push hard
${isTaxDelinquent ? `\nIMPORTANT: This seller has past-due taxes. If relevant, mention you can help them get out before county action.` : ""}
${ownerFinanceSellPrice ? `\nAlternative exit you can sell to a buyer later: Owner financing at $${ownerFinanceSellPrice.toLocaleString()} — $${ownerFinanceDown.toLocaleString()} down + $${ownerFinanceMonthly}/month. You don't need to mention this to the seller — it's your exit strategy.` : ""}

Keep replies SHORT — 1-3 sentences, SMS tone. Goal: get them to accept or schedule a call.
If they counter, hold firm first then offer to "see what I can do" (come up 5-10% max).
If they say yes or want to move forward, ask for their email to send the purchase agreement.
Ask the four qualification questions naturally if info is missing: title owner, back taxes, timeline, best price.
Sign as "- Jon"`,
    messages,
  });

  return msg.content[0].text.trim();
}
