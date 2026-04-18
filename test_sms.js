/**
 * test_sms.js
 * Sends a test SMS to YOUR_PHONE to verify Twilio is wired up.
 * Usage: node test_sms.js
 */

import twilio from "twilio";
import dotenv from "dotenv";
dotenv.config();

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_PHONE;
const TO = process.env.YOUR_PHONE;

if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  console.error("❌ TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set in .env");
  process.exit(1);
}
if (!TO || TO.includes("XXXXXXXX")) {
  console.error("❌ Set YOUR_PHONE in .env to your real number (e.g. +14017716184)");
  process.exit(1);
}

console.log(`\n📱 Sending test SMS from ${FROM} → ${TO}...`);

try {
  const msg = await client.messages.create({
    body: "✅ Land bot SMS test — Twilio is wired up and texting is live! - Jon",
    from: FROM,
    to: TO,
  });
  console.log(`✅ Sent! SID: ${msg.sid}`);
  console.log(`   Status: ${msg.status}`);
} catch (err) {
  console.error(`❌ Failed: ${err.message}`);
  if (err.code) console.error(`   Twilio error code: ${err.code}`);
}
