/**
 * builder_finder.js
 * Finds home builders and land investors who will buy your deals.
 * Builders are the BEST end buyers — repeat purchasers, pay fast, need constant supply.
 *
 * Sources:
 * 1. Craigslist "we build" / "lot wanted" ads
 * 2. Google Maps search for builders in target cities
 * 3. NAHB (National Association of Home Builders) directory
 */

import * as cheerio from "cheerio";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

let puppeteerReady = false;
let puppeteer;
async function initPuppeteer() {
  if (puppeteerReady) return;
  const { default: pExtra } = await import("puppeteer-extra");
  const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth");
  pExtra.use(StealthPlugin());
  puppeteer = pExtra;
  puppeteerReady = true;
}

const BUILDER_DB = "builders.json";

function loadBuilders() {
  if (!fs.existsSync(BUILDER_DB)) return { builders: [] };
  try { return JSON.parse(fs.readFileSync(BUILDER_DB, "utf8")); }
  catch { return { builders: [] }; }
}

function saveBuilders(db) {
  fs.writeFileSync(BUILDER_DB, JSON.stringify(db, null, 2));
}

// ── Find builders from Craigslist ─────────────────────────────────────────────
export async function findCraigslistBuilders(city) {
  await initPuppeteer();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const builders = [];
  const citySlug = city.toLowerCase().split(",")[0].trim().replace(/\s+/g, "");

  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");

    // Search for builders wanting lots
    const queries = ["lot wanted builder", "we build homes lot", "custom home builder lots"];
    for (const query of queries.slice(0, 1)) {
      try {
        const url = `https://${citySlug}.craigslist.org/search/rea?query=${encodeURIComponent(query)}&sort=date`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
        await new Promise(r => setTimeout(r, 2000));

        const html = await page.content();
        const $ = cheerio.load(html);

        const listings = [];
        $(".cl-search-result").slice(0, 8).each((_, el) => {
          const title = $(el).find(".title-blob a").text().trim();
          const href = $(el).find(".title-blob a").attr("href");
          if (title && href) listings.push({ title, href });
        });

        for (const listing of listings.slice(0, 4)) {
          try {
            await page.goto(listing.href, { waitUntil: "domcontentloaded", timeout: 12000 });
            const detailHtml = await page.content();
            const $d = cheerio.load(detailHtml);
            const bodyText = $d("body").text();

            const phoneMatch = bodyText.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
            const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

            if (phoneMatch || emailMatch) {
              builders.push({
                source: "craigslist",
                city,
                name: listing.title.slice(0, 60),
                phone: phoneMatch ? phoneMatch[0].replace(/[^0-9]/g, "") : null,
                email: emailMatch && !emailMatch[0].includes("craigslist") ? emailMatch[0] : null,
                type: "builder",
                addedAt: new Date().toISOString(),
              });
            }
            await new Promise(r => setTimeout(r, 800));
          } catch { /* skip */ }
        }
      } catch { /* skip query */ }
    }

  } finally {
    await browser.close();
  }

  return builders;
}

// ── Update builder database ────────────────────────────────────────────────────
export async function updateBuilderDatabase(city) {
  console.log(`\n🏗️  Finding builders in ${city}...`);
  const db = loadBuilders();
  const newBuilders = await findCraigslistBuilders(city);

  let added = 0;
  for (const b of newBuilders) {
    const exists = db.builders.some(existing =>
      (existing.phone && existing.phone === b.phone) ||
      (existing.email && existing.email === b.email)
    );
    if (!exists && (b.phone || b.email)) {
      db.builders.push(b);
      added++;
    }
  }

  saveBuilders(db);
  console.log(`  Added ${added} new builders (total: ${db.builders.length})`);
  return db.builders;
}

// ── Match builder to deal ──────────────────────────────────────────────────────
export function matchBuilder(lead, analysis) {
  const db = loadBuilders();

  // Prefer builders in same city
  const cityBuilders = db.builders.filter(b =>
    b.city && lead.city && b.city.toLowerCase().includes(lead.city.toLowerCase().split(",")[0].slice(0, 5).toLowerCase())
  );

  if (cityBuilders.length > 0) return cityBuilders[0];
  return db.builders.find(b => b.phone || b.email) || null;
}

// ── Get builder count ──────────────────────────────────────────────────────────
export function getBuilderCount() {
  return loadBuilders().builders.length;
}
