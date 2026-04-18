/**
 * test_pipeline.js
 * Runs one fake lead through the full pipeline:
 * analyzeLand → generateOfferMessage → sendOfferSMS (to YOUR_PHONE)
 * This proves the whole chain works end to end.
 */

import dotenv from "dotenv";
dotenv.config();

import { analyzeLand, generateOfferMessage } from "./land_analyzer.js";
import { sendOfferSMS } from "./sms_bot.js";

const testLead = {
  source: "tax_delinquent_land",
  motivation: "taxDelinquent",
  city: "Nashville, TN",
  address: "1842 Elm Ridge Rd, Nashville, TN",
  askingPrice: 45000,
  acreage: 2.3,
  phone: process.env.YOUR_PHONE?.replace(/[^0-9]/g, "") || "4017716184",
  description: "Vacant wooded lot, road access, back taxes owed",
  scrapedAt: new Date().toISOString(),
};

console.log("\n🧪 Pipeline test starting...\n");
console.log(`Lead: ${testLead.address} (${testLead.acreage} acres, asking $${testLead.askingPrice.toLocaleString()})`);
console.log(`Source: ${testLead.source}\n`);

const analysis = await analyzeLand(testLead);

console.log("\n📊 Analysis result:");
console.log(`  Market value:  $${analysis.estimatedMarketValue?.toLocaleString()}`);
console.log(`  Our offer:     $${analysis.ourOffer?.toLocaleString()}`);
console.log(`  Sell to buyer: $${analysis.sellPriceToBuilder?.toLocaleString()}`);
console.log(`  Profit:        $${analysis.assignmentFee?.toLocaleString()}`);
console.log(`  Deal score:    ${analysis.dealScore}`);
console.log(`  Builder appeal:${analysis.builderAppeal}`);
if (analysis.redFlags?.length) console.log(`  Red flags:     ${analysis.redFlags.join(", ")}`);

if (analysis.dealScore === "pass") {
  console.log("\n⏭️  Deal scored 'pass' — would be skipped in production");
  process.exit(0);
}

const offerMsg = await generateOfferMessage(testLead, analysis);
console.log(`\n💬 Generated offer SMS:\n"${offerMsg}"`);

console.log(`\n📱 Sending to YOUR number (${process.env.YOUR_PHONE}) as test...`);
await sendOfferSMS(testLead.phone, offerMsg, "TEST_LEAD_001");
console.log("\n✅ Pipeline test complete — check your phone!");
