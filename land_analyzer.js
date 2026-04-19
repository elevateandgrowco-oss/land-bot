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

  // Step 4: Deal score — use AI qualification only, never pre-reject based on price math
  // Seller sets the price, we make the offer — let them say no
  let dealScore = qualification.score;

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

  const firstName = lead.ownerName ? lead.ownerName.split(" ")[0] : null;
  const greeting = firstName ? `Hey ${firstName}` : "Hey";
  const shortAddr = lead.address.split(",")[0];

  const msg = await claude.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 120,
    system: "You write text messages that sound exactly like a real person texting from their phone. No sales language. No buzzwords. Output ONLY the message text — nothing else.",
    messages: [{
      role: "user",
      content: `Write a first text to someone who owns a vacant lot. You want to buy it.

Start with: "${greeting}"
Street address only (don't mention city/state): ${shortAddr}
${lead.acreage ? `Lot size: ${lead.acreage} acres` : ""}
${isNearConstruction ? "Context: builders are active in this area right now" : ""}
${isTaxDelinquent ? "Context: they have back taxes on it" : ""}

Rules:
- Sound like a real person, not an investor
- 1-2 sentences MAX
- Ask if they'd be open to selling AND what they'd want for it — get THEM to name a price first
- Do NOT say: "cash offer", "fast close", "zero fees", "no agents", "I'm a buyer"
- Casual and direct, like a neighbor texting
- End with "- Jon"
- Output the message only`,
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

Keep replies SHORT — 1-2 sentences, casual texting tone. Sound like a real person, not an investor.
Never use: "cash offer", "fast close", "no agents", "zero fees" — just talk normally.

TTP STRATEGY (Talk To People):
- If they haven't named a price yet: ask "what would you need to get for it?"
- If they named a price: pause, come back lower — "hmm that's a little more than I can do, what's the absolute lowest you'd take?"
- Only reveal our number ($${analysis.ourOffer?.toLocaleString()}) after they've anchored first
- If they counter above our max: offer owner financing — "I could do more on payments — would that work?"
- If they say yes or want to move forward: ask for their email to send the paperwork
- One qualification question at a time if info is missing: back taxes? anyone else on title? timeline?
Sign as "- Jon"`,
    messages,
  });

  return msg.content[0].text.trim();
}
