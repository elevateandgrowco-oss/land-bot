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

import http from "http";
import cron from "node-cron";

// Keep-alive HTTP server — prevents Railway from auto-sleeping the container
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("land-bot running\n");
}).listen(PORT, () => console.log(`✅ Health server on port ${PORT}`));
import { findLeads } from "./lead_finder.js";
import { analyzeLand, generateOfferMessage } from "./land_analyzer.js";
import { sendOfferSMS, runFollowUps } from "./sms_bot.js";
import { sendOutreachEmail } from "./email_outreach.js";
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

  // Skip if deal math doesn't work
  if (!analysis.ourOffer || analysis.ourOffer <= 0) {
    console.log(`   ⚠️  Could not calculate offer — skipping`);
    addLead(log, { ...lead, analysis, skipReason: "no offer calculated" });
    saveLog(log);
    return;
  }

  // Skip weak/rejected deals — only voicemail leads worth pursuing
  if (analysis.dealScore === "pass") {
    console.log(`   🚫 Deal score: pass — skipping (numbers don't work)`);
    addLead(log, { ...lead, analysis, skipReason: "deal score pass" });
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

    // Also send email if we have one from skip trace (double touch = more responses)
    if (lead.email) {
      try {
        await sendOutreachEmail(lead, analysis);
        console.log(`   📧 Email sent to ${lead.email}`);
        updateLead(log, loggedLead.id, { emailSent: true });
        saveLog(log);
      } catch (err) {
        console.error(`   ❌ Email failed: ${err.message}`);
      }
    }
  } else {
    console.log(`   [DRY RUN] Would text ${lead.phone}${lead.email ? ` + email ${lead.email}` : ""}`);
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

// Run immediately on startup
main().catch(err => console.error("Startup run failed:", err.message));

// Then run at 8am, 10am, 12pm, 2pm, 4pm, 6pm, 8pm ET every day
cron.schedule("0 8,10,12,14,16,18,20 * * *", () => {
  console.log(`\n⏰ Scheduled run — ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}`);
  main().catch(err => console.error("Scheduled run failed:", err.message));
}, { timezone: "America/New_York" });

console.log("⏰ Scheduler active — runs at 9am, 12pm, 3pm, 6pm, 8pm ET daily");
