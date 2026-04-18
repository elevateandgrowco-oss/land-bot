/**
 * Land Flipping Bot
 * Strategy: Jack Bosch / Pete Reese / Mark Podolsky
 *
 * Pipeline:
 * 1. Find vacant land listings (LandWatch, Zillow, CSV import)
 * 2. Analyze deal — price/acre vs market, offer at 30% of value
 * 3. Text seller with cash offer via Twilio
 * 4. AI handles all replies automatically (Claude)
 * 5. Generate Purchase & Sale Agreement when seller accepts
 * 6. Find home builder to assign contract to
 * 7. Generate Assignment Contract
 * 8. Collect assignment fee ($5K-$15K) at closing
 */

import dotenv from "dotenv";
dotenv.config();

import { findLeads } from "./lead_finder.js";
import { analyzeLand, generateOfferMessage } from "./land_analyzer.js";
import { sendOfferSMS, runFollowUps } from "./sms_bot.js";
import { updateBuilderDatabase, getBuilderCount } from "./builder_finder.js";
import { loadLog, saveLog, hasBeenContacted, addLead, updateLead, printSummary } from "./leads_log.js";

const DRY_RUN  = process.env.DRY_RUN === "true" || process.argv.includes("--dry-run");
const MAX_LEADS = parseInt(process.env.MAX_LEADS_PER_RUN || "20");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processLead(lead, log) {
  console.log(`\n${"─".repeat(55)}`);
  console.log(`🌿 ${lead.address}`);
  if (lead.acreage) console.log(`   ${lead.acreage} acres`);
  console.log(`   Asking: $${lead.askingPrice?.toLocaleString() || "unknown"} | Source: ${lead.source}`);

  // Skip if already contacted
  if (hasBeenContacted(log, lead.address)) {
    console.log(`   ⏭️  Already contacted — skipping`);
    return;
  }

  // Skip if no phone
  if (!lead.phone) {
    console.log(`   ⚠️  No phone number — skipping`);
    addLead(log, { ...lead, skipReason: "no phone" });
    saveLog(log);
    return;
  }

  // Skip if price is clearly junk data (negative or absurdly high)
  if (lead.askingPrice && lead.askingPrice > 10000000) {
    console.log(`   ⚠️  Price looks like bad data ($${lead.askingPrice}) — skipping`);
    return;
  }

  // Analyze the land deal
  let analysis;
  try {
    analysis = await analyzeLand(lead);
  } catch (err) {
    console.error(`   ❌ Analysis failed: ${err.message}`);
    return;
  }

  console.log(`   Market value: ~$${analysis.estimatedMarketValue?.toLocaleString()}`);
  console.log(`   Our offer:    $${analysis.ourOffer?.toLocaleString()}`);
  console.log(`   Sell to builder: $${analysis.sellPriceToBuilder?.toLocaleString()}`);
  console.log(`   Assignment fee:  $${analysis.assignmentFee?.toLocaleString()}`);
  console.log(`   Builder appeal: ${analysis.builderAppeal} | Score: ${analysis.dealScore}`);
  if (analysis.redFlags?.length > 0) {
    console.log(`   ⚠️  Red flags: ${analysis.redFlags.join(", ")}`);
  }

  // Only skip if we have no offer number at all
  if (!analysis.ourOffer || analysis.ourOffer <= 0) {
    console.log(`   ⚠️  Could not calculate offer — skipping`);
    addLead(log, { ...lead, analysis, skipReason: "no offer calculated" });
    saveLog(log);
    return;
  }

  // Log the lead
  const loggedLead = addLead(log, { ...lead, analysis });
  saveLog(log);

  // Generate offer SMS
  const offerMessage = await generateOfferMessage(lead, analysis);
  console.log(`   📱 Message: "${offerMessage}"`);

  // Send SMS
  if (!DRY_RUN) {
    try {
      await sendOfferSMS(lead.phone, offerMessage, loggedLead.id);
      updateLead(log, loggedLead.id, { status: "contacted" });
      saveLog(log);
    } catch (err) {
      console.error(`   ❌ SMS failed: ${err.message}`);
    }
  } else {
    console.log(`   [DRY RUN] Would text ${lead.phone}`);
  }

  await sleep(2000);
}

async function main() {
  console.log(`\n${"=".repeat(55)}`);
  console.log(`  LAND FLIPPING BOT`);
  console.log(`  ${new Date().toLocaleString()}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`  Builders in database: ${getBuilderCount()}`);
  console.log(`${"=".repeat(55)}\n`);

  const log = loadLog();

  // Step 1: Find land leads
  const leads = await findLeads(MAX_LEADS);

  if (!leads.length) {
    console.log("⚠️  No leads found this run.");
  } else {
    console.log(`\n🚀 Processing ${leads.length} leads...\n`);
    for (const lead of leads) {
      await processLead(lead, log);
    }
  }

  // Step 2: Run follow-ups
  console.log(`\n${"─".repeat(55)}`);
  console.log(`📬 Running follow-ups...`);
  await runFollowUps(DRY_RUN);

  // Step 3: Build builder database
  console.log(`\n${"─".repeat(55)}`);
  console.log(`🏗️  Building builder database...`);
  try {
    const cities = ["austin", "nashville", "charlotte", "tampa", "atlanta"];
    const city = cities[Math.floor(Math.random() * cities.length)];
    await updateBuilderDatabase(city);
  } catch (err) {
    console.log(`   ⚠️  Builder scrape failed: ${err.message}`);
  }

  printSummary(log);
}

main().catch(err => {
  console.error("Bot crashed:", err);
  process.exit(1);
});
