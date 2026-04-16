/**
 * webhook.js
 * Twilio webhook for incoming seller SMS replies.
 *
 * Deploy to Railway as always-on service.
 * Set Twilio webhook to: https://YOUR-RAILWAY-URL/sms
 */

import express from "express";
import { handleIncomingSMS } from "./sms_bot.js";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post("/sms", async (req, res) => {
  const from = req.body.From || req.body.from;
  const body = req.body.Body || req.body.body;

  console.log(`\n📱 Webhook: from=${from} body="${body}"`);

  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  try {
    await handleIncomingSMS(from, body);
  } catch (err) {
    console.error("❌ SMS handler error:", err.message);
  }
});

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "land-bot-webhook", time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n✅ Land Bot webhook running on port ${PORT}`);
  console.log(`   POST /sms — Twilio incoming handler`);
});
