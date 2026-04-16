/**
 * sms_bot.js
 * Handles SMS outreach and AI replies for land leads via Twilio.
 */

import twilio from "twilio";
import dotenv from "dotenv";
import { handleSellerReply } from "./land_analyzer.js";
import { loadLog, saveLog, getLead, updateLead } from "./leads_log.js";
dotenv.config();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const FROM = process.env.TWILIO_PHONE;

function formatPhone(phone) {
  const digits = phone.replace(/[^0-9]/g, "");
  return digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
}

// ── Send initial offer SMS ────────────────────────────────────────────────────
export async function sendOfferSMS(phone, message, leadId) {
  if (!phone) throw new Error("No phone number");
  const e164 = formatPhone(phone);

  const result = await client.messages.create({ body: message, from: FROM, to: e164 });
  console.log(`   ✉️  SMS sent to ${e164} — SID: ${result.sid}`);

  const log = loadLog();
  updateLead(log, leadId, {
    smsSent: true,
    smsSentAt: new Date().toISOString(),
    twilioSid: result.sid,
    conversation: [{ role: "assistant", content: message, timestamp: new Date().toISOString() }],
  });
  saveLog(log);

  return result.sid;
}

// ── Send follow-up SMS ────────────────────────────────────────────────────────
export async function sendFollowUpSMS(phone, message, leadId, followUpNum) {
  const e164 = formatPhone(phone);
  const result = await client.messages.create({ body: message, from: FROM, to: e164 });
  console.log(`   ✉️  Follow-up #${followUpNum} sent to ${e164}`);

  const log = loadLog();
  const lead = getLead(log, leadId);
  if (lead) {
    const conv = lead.conversation || [];
    conv.push({ role: "assistant", content: message, timestamp: new Date().toISOString() });
    updateLead(log, leadId, {
      [`followUp${followUpNum}SentAt`]: new Date().toISOString(),
      conversation: conv,
    });
    saveLog(log);
  }

  return result.sid;
}

// ── Handle incoming SMS from seller ──────────────────────────────────────────
export async function handleIncomingSMS(fromPhone, body) {
  console.log(`\n📱 Incoming from ${fromPhone}: "${body}"`);

  const log = loadLog();
  const lead = log.leads.find(l =>
    l.phone && l.phone.replace(/[^0-9]/g, "").endsWith(fromPhone.replace(/[^0-9]/g, "").slice(-10))
  );

  if (!lead) {
    console.log(`   ⚠️  No lead found for ${fromPhone}`);
    return;
  }

  console.log(`   📍 Matched: ${lead.address}`);

  // Unsubscribe check
  const unsubWords = ["stop", "unsubscribe", "quit", "cancel", "remove"];
  if (unsubWords.some(w => body.toLowerCase().includes(w))) {
    updateLead(log, lead.id, { unsubscribed: true });
    saveLog(log);
    await client.messages.create({
      body: "You've been removed from our list. Sorry to bother you!",
      from: FROM,
      to: fromPhone,
    });
    return;
  }

  // Build history and get AI reply
  const conv = lead.conversation || [];
  const history = conv.map(m => ({ role: m.role, content: m.content }));
  const aiReply = await handleSellerReply(lead, lead.analysis, body, history);
  console.log(`   🤖 AI reply: "${aiReply}"`);

  // Send reply
  await client.messages.create({ body: aiReply, from: FROM, to: fromPhone });

  // Update log
  conv.push({ role: "user", content: body, timestamp: new Date().toISOString() });
  conv.push({ role: "assistant", content: aiReply, timestamp: new Date().toISOString() });
  updateLead(log, lead.id, {
    conversation: conv,
    lastReplyAt: new Date().toISOString(),
    status: "in_conversation",
  });
  saveLog(log);

  // Hot lead alert
  const hotWords = ["yes", "interested", "offer", "how much", "cash", "when", "sure", "deal", "okay", "accept"];
  if (hotWords.some(w => body.toLowerCase().includes(w))) {
    console.log(`\n🔥 HOT LAND LEAD — ${lead.address}`);
    console.log(`   Our offer: $${lead.analysis?.ourOffer?.toLocaleString()}`);
    console.log(`   Assign to builder at: $${lead.analysis?.sellPriceToBuilder?.toLocaleString()}`);
    console.log(`   Your profit: $${lead.analysis?.assignmentFee?.toLocaleString()}`);
    console.log(`   Phone: ${fromPhone}`);
  }
}

// ── Follow-up sequence ────────────────────────────────────────────────────────
export async function runFollowUps(dryRun = false) {
  const log = loadLog();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  for (const lead of log.leads) {
    if (!lead.phone || lead.unsubscribed || lead.status === "closed") continue;
    const sentAt = lead.smsSentAt ? new Date(lead.smsSentAt).getTime() : null;
    if (!sentAt) continue;

    const daysSince = (now - sentAt) / DAY;
    const hasReplied = lead.conversation?.some(m => m.role === "user");

    // Follow-up 1: Day 4
    if (!lead.followUp1SentAt && daysSince >= 4 && !hasReplied) {
      const shortAddr = lead.address.split(",")[0];
      const msg = `Just following up on your land near ${shortAddr}. Still able to make you a cash offer and close in 2-3 weeks. Interested? - Jon`;
      if (!dryRun) {
        await sendFollowUpSMS(lead.phone, msg, lead.id, 1);
      } else {
        console.log(`[DRY RUN] Follow-up 1 → ${lead.phone}: "${msg}"`);
      }
    }

    // Follow-up 2: Day 10
    if (!lead.followUp2SentAt && daysSince >= 10 && !hasReplied) {
      const shortAddr = lead.address.split(",")[0];
      const msg = `Last follow-up on ${shortAddr} — if the timing isn't right, no worries at all. We buy land regularly in this area. Reach out anytime. - Jon`;
      if (!dryRun) {
        await sendFollowUpSMS(lead.phone, msg, lead.id, 2);
      } else {
        console.log(`[DRY RUN] Follow-up 2 → ${lead.phone}: "${msg}"`);
      }
    }
  }
}
