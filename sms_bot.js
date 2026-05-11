/**
 * sms_bot.js
 * Handles SMS outreach and AI replies for land leads via Twilio.
 */

import twilio from "twilio";
import dotenv from "dotenv";
import { dropVoicemail } from "./voicemail_dropper.js";
import { handleSellerReply } from "./land_analyzer.js";
import { loadLog, saveLog, getLead, updateLead } from "./leads_log.js";
import { checkOutreachAllowed } from "./outreach_guard.js";
import { checkSMSRampAllowed, recordSMSSent } from "./sms_ramp.js";
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
  const log = loadLog();
  const lead = getLead(log, leadId) || { phone };

  // RVM guard — DNC/quiet-hours/Slybroadcast check BEFORE dropping voicemail.
  // Slybroadcast is independent of Twilio A2P — RVM can run while SMS is locked.
  const rvmGuard = checkOutreachAllowed(lead, "rvm");
  if (rvmGuard.allowed) {
    await dropVoicemail(phone);
    updateLead(log, leadId, { voicemailSent: true, voicemailSentAt: new Date().toISOString() });
    saveLog(log);
  } else {
    console.log(`   ⏭️  RVM skipped (${rvmGuard.reason}) → ${e164}`);
  }

  // SMS guard — blocked until Twilio A2P approved
  const smsGuard = checkOutreachAllowed(lead, "sms");
  if (!smsGuard.allowed) {
    console.log(`   🚫 SMS blocked (${smsGuard.reason}) → ${e164}`);
    return null;
  }

  const ramp = checkSMSRampAllowed();
  if (!ramp.allowed) {
    console.log(`   🚦 SMS ramp limit (${ramp.sent}/${ramp.limit} today) → ${e164}`);
    return null;
  }

  try {
    const result = await client.messages.create({ body: message, from: FROM, to: e164 });
    console.log(`   ✉️  SMS sent to ${e164} — SID: ${result.sid}`);
    recordSMSSent();
    updateLead(log, leadId, {
      smsSent: true,
      smsSentAt: new Date().toISOString(),
      twilioSid: result.sid,
      conversation: [{ role: "assistant", content: message, timestamp: new Date().toISOString() }],
    });
    saveLog(log);
    return result.sid;
  } catch (err) {
    console.log(`   ⏭️  SMS skipped (Twilio not ready): ${err.message}`);
    return null;
  }
}

// ── Send follow-up SMS ────────────────────────────────────────────────────────
export async function sendFollowUpSMS(phone, message, leadId, followUpNum) {
  const e164 = formatPhone(phone);
  const log = loadLog();
  const lead = getLead(log, leadId) || { phone };
  const guard = checkOutreachAllowed(lead, "sms");
  if (!guard.allowed) {
    console.log(`   🚫 Follow-up SMS blocked (${guard.reason}) → ${e164}`);
    return null;
  }

  const ramp = checkSMSRampAllowed();
  if (!ramp.allowed) {
    console.log(`   🚦 SMS ramp limit (${ramp.sent}/${ramp.limit} today) → ${e164}`);
    return null;
  }

  const result = await client.messages.create({ body: message, from: FROM, to: e164 });
  console.log(`   ✉️  Follow-up #${followUpNum} sent to ${e164}`);
  recordSMSSent();

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

  // Hot lead alert — notify owner by SMS
  const hotWords = ["yes", "interested", "offer", "how much", "cash", "when", "sure", "deal", "okay", "accept"];
  if (hotWords.some(w => body.toLowerCase().includes(w))) {
    console.log(`\n🔥 HOT LAND LEAD — ${lead.address}`);
    console.log(`   Our offer: $${lead.analysis?.ourOffer?.toLocaleString()}`);
    console.log(`   Assign at: $${lead.analysis?.sellPriceToBuilder?.toLocaleString()}`);
    console.log(`   Your profit: $${lead.analysis?.assignmentFee?.toLocaleString()}`);
    console.log(`   Phone: ${fromPhone}`);
    // Alert owner
    try {
      await client.messages.create({
        body: `🔥 HOT LEAD (Land)\n${lead.address}\nSeller said: "${body}"\nOffer: $${lead.analysis?.ourOffer?.toLocaleString()}\nYour profit: $${lead.analysis?.assignmentFee?.toLocaleString()}\nCall/text them: ${fromPhone}`,
        from: FROM,
        to: "+14017716184",
      });
    } catch (e) {
      console.error("Alert failed:", e.message);
    }
  }
}

// ── Follow-up message templates ───────────────────────────────────────────────
function getFollowUpMessage(lead, followUpNum) {
  const shortAddr = lead.address.split(",")[0];
  const offer = lead.analysis?.ourOffer ? `$${lead.analysis.ourOffer.toLocaleString()}` : "a fair cash offer";
  const nearConstruction = lead.nearConstruction;
  const firstName = lead.ownerName ? lead.ownerName.split(" ")[0] : null;
  const hey = firstName ? `Hey ${firstName},` : "Hey,";

  const messages = {
    1: nearConstruction
      ? `${hey} did my last text come through? Wanted to ask about ${shortAddr} — Jon. Reply STOP to opt out`
      : `${hey} just checking if you got my text about ${shortAddr} — Jon. Reply STOP to opt out`,

    2: nearConstruction
      ? `${hey} still looking to buy in that area if you're open to it. No pressure either way — Jon. Reply STOP to opt out`
      : `${hey} still interested in ${shortAddr} if the timing ever works out — Jon. Reply STOP to opt out`,

    3: `${hey} last one, I promise. Would you do ${offer} for ${shortAddr}? I can close whenever works for you — Jon. Reply STOP to opt out`,

    4: `${hey} just circling back. Still buying in the area if you ever change your mind on ${shortAddr} — Jon. Reply STOP to opt out`,
  };

  return messages[followUpNum] || messages[4];
}

// ── Follow-up sequence ────────────────────────────────────────────────────────
export async function runFollowUps(dryRun = false) {
  const log = loadLog();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  // Follow-up schedule (days since initial SMS):
  // #1 → Day 1 (next day check-in)
  // #2 → Day 3 (urgency nudge)
  // #3 → Day 7 (price flexibility hint)
  // #4 → Day 21 (final re-engagement)
  const schedule = [
    { num: 1, minDays: 1, field: "followUp1SentAt" },
    { num: 2, minDays: 3, field: "followUp2SentAt" },
    { num: 3, minDays: 7, field: "followUp3SentAt" },
    { num: 4, minDays: 21, field: "followUp4SentAt" },
  ];

  for (const lead of log.leads) {
    if (!lead.phone || lead.unsubscribed || lead.status === "closed") continue;
    const sentAt = lead.smsSentAt ? new Date(lead.smsSentAt).getTime() : null;
    if (!sentAt) continue;

    const daysSince = (now - sentAt) / DAY;
    const hasReplied = lead.conversation?.some(m => m.role === "user");

    // Don't send follow-ups 1-3 if seller has already replied (still send #4 for re-engagement)
    for (const step of schedule) {
      if (lead[step.field]) continue; // already sent
      if (daysSince < step.minDays) continue; // too early
      if (hasReplied && step.num < 4) continue; // replied — skip routine follow-ups

      const msg = getFollowUpMessage(lead, step.num);

      if (!dryRun) {
        await sendFollowUpSMS(lead.phone, msg, lead.id, step.num);
      } else {
        console.log(`[DRY RUN] Follow-up #${step.num} (day ${step.minDays}+) → ${lead.phone}: "${msg}"`);
      }

      // Only send one follow-up per run per lead to avoid flooding
      break;
    }
  }
}
