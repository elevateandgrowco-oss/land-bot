/**
 * contract_generator.js
 * Generates land wholesale contracts:
 * 1. Purchase & Sale Agreement (with seller)
 * 2. Assignment of Contract (to builder/end buyer)
 * 3. Addendum (for modifications)
 *
 * Sends via email using Resend.
 */

import { Resend } from "resend";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { LAND_KNOWLEDGE } from "./knowledge.js";
dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Generate Purchase & Sale Agreement ───────────────────────────────────────
async function generatePurchaseAgreement(lead, analysis, closingDate) {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const closing = closingDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const msg = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2500,
    system: LAND_KNOWLEDGE,
    messages: [{
      role: "user",
      content: `Generate a vacant land Purchase and Sale Agreement with these details:

Property Address: ${lead.address}
${lead.acreage ? `Acreage: ${lead.acreage} acres` : ""}
Buyer: Jon Dior and/or assigns
Seller: [SELLER NAME]
Purchase Price: $${analysis.ourOffer?.toLocaleString()}
Earnest Money: $100 (non-refundable after inspection period)
Inspection Period: 30 days
Closing Date: ${closing}
Date: ${today}

Include these clauses:
- "And/or assigns" buyer clause (CRITICAL for wholesaling)
- As-is, where-is condition
- 30-day inspection/due diligence period
- Seller warrants clear and marketable title
- Seller pays any outstanding taxes or liens
- No survey required unless buyer requests
- Assignment rights clause (buyer may assign without seller consent)
- Default clause
- Earnest money terms ($100, held by title company)
- Each party pays own closing costs
- Signature lines for buyer and seller with date

Format as a clean, professional real estate contract. Use standard legal language.`,
    }],
  });

  return msg.content[0].text;
}

// ── Generate Assignment of Contract ──────────────────────────────────────────
async function generateAssignmentContract(lead, analysis, buyerName, assignmentFee) {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const msg = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    system: LAND_KNOWLEDGE,
    messages: [{
      role: "user",
      content: `Generate an Assignment of Contract for a land wholesale deal:

Property: ${lead.address}
Original Buyer (Assignor): Jon Dior
New Buyer (Assignee): ${buyerName || "[BUYER NAME]"}
Original Purchase Price: $${analysis.ourOffer?.toLocaleString()}
Assignment Fee: $${(assignmentFee || analysis.assignmentFee)?.toLocaleString()}
Total Assignee Pays: $${analysis.sellPriceToBuilder?.toLocaleString()}
Date: ${today}

Include:
- Assignor transfers all rights in original Purchase & Sale Agreement
- Assignee agrees to pay assignment fee at closing
- Assignee assumes all obligations of original contract
- This assignment is irrevocable once signed
- Signature lines for both parties

Professional format, standard legal language.`,
    }],
  });

  return msg.content[0].text;
}

// ── Send Purchase Agreement to seller ────────────────────────────────────────
export async function sendPurchaseAgreement(lead, analysis, sellerEmail, sellerName) {
  console.log(`  📄 Generating Purchase Agreement for ${lead.address}...`);

  const contractText = await generatePurchaseAgreement(lead, analysis);

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">
  <h2>Purchase and Sale Agreement — Vacant Land</h2>
  <p>Dear ${sellerName || "Property Owner"},</p>
  <p>Thank you for speaking with me about your property at ${lead.address}. As discussed, please find our purchase agreement below.</p>
  <p><strong>Purchase Price: $${analysis.ourOffer?.toLocaleString()}</strong></p>
  <p>To accept, simply reply with your typed name and today's date — or let me know if you'd prefer a DocuSign.</p>
  <hr>
  <pre style="white-space: pre-wrap; font-family: Georgia, serif; font-size: 13px; line-height: 1.8;">${contractText}</pre>
  <hr>
  <p>Questions? Reply to this email or text/call me directly.</p>
  <p>— Jon Dior<br>${process.env.YOUR_PHONE || ""}</p>
</body>
</html>`;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to: sellerEmail,
    subject: `Land Purchase Agreement — ${lead.address}`,
    html,
  });

  console.log(`  ✅ Purchase Agreement sent to ${sellerEmail}`);
  return contractText;
}

// ── Send Assignment Contract to builder ───────────────────────────────────────
export async function sendAssignmentContract(lead, analysis, builderEmail, builderName) {
  console.log(`  📄 Generating Assignment Contract for ${lead.address}...`);

  const contractText = await generateAssignmentContract(lead, analysis, builderName);

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">
  <h2>Assignment of Contract — Land Deal</h2>
  <p>Dear ${builderName || "Builder"},</p>
  <p>As discussed, here is the Assignment of Contract for the land at ${lead.address}.</p>
  <p><strong>Your total investment: $${analysis.sellPriceToBuilder?.toLocaleString()}</strong>
     (includes $${analysis.assignmentFee?.toLocaleString()} assignment fee)</p>
  ${lead.acreage ? `<p>Acreage: ${lead.acreage} acres</p>` : ""}
  <p>Please sign and return at your earliest convenience. I'll coordinate with the title company for closing.</p>
  <hr>
  <pre style="white-space: pre-wrap; font-family: Georgia, serif; font-size: 13px; line-height: 1.8;">${contractText}</pre>
  <hr>
  <p>— Jon Dior<br>${process.env.YOUR_PHONE || ""}</p>
</body>
</html>`;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to: builderEmail,
    subject: `Land Deal — ${lead.address} — Assignment Contract`,
    html,
  });

  console.log(`  ✅ Assignment Contract sent to ${builderEmail}`);
  return contractText;
}
