/**
 * lead_finder.js
 * Finds vacant land listings from:
 * 1. Manual CSV import (primary — use county tax records, LandWatch download, etc.)
 * 2. LandWatch.com scraper
 * 3. Zillow lots/land filter
 *
 * FREE LEAD SOURCES:
 *   - County assessor websites: search by property type = "vacant land"
 *   - LandWatch.com: filter by state → download or copy listings
 *   - Zillow: filter homes → Lot/Land → sort by "Days on Market"
 *   - State tax delinquent lists: usually free PDFs on county treasurer sites
 *   Put any CSV with [address, phone, askingPrice, acreage] as: leads_import.csv
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as cheerio from "cheerio";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

puppeteer.use(StealthPlugin());

// High-growth markets where builders need lots
const MARKETS = [
  { name: "Austin, TX",       state: "TX", landwatch: "texas/travis-county" },
  { name: "Nashville, TN",    state: "TN", landwatch: "tennessee/davidson-county" },
  { name: "Charlotte, NC",    state: "NC", landwatch: "north-carolina/mecklenburg-county" },
  { name: "Phoenix, AZ",      state: "AZ", landwatch: "arizona/maricopa-county" },
  { name: "Tampa, FL",        state: "FL", landwatch: "florida/hillsborough-county" },
  { name: "Atlanta, GA",      state: "GA", landwatch: "georgia/fulton-county" },
  { name: "Dallas, TX",       state: "TX", landwatch: "texas/dallas-county" },
  { name: "Denver, CO",       state: "CO", landwatch: "colorado/denver-county" },
  { name: "Raleigh, NC",      state: "NC", landwatch: "north-carolina/wake-county" },
  { name: "Jacksonville, FL", state: "FL", landwatch: "florida/duval-county" },
  { name: "San Antonio, TX",  state: "TX", landwatch: "texas/bexar-county" },
  { name: "Orlando, FL",      state: "FL", landwatch: "florida/orange-county" },
  { name: "Houston, TX",      state: "TX", landwatch: "texas/harris-county" },
  { name: "Columbus, OH",     state: "OH", landwatch: "ohio/franklin-county" },
  { name: "Indianapolis, IN", state: "IN", landwatch: "indiana/marion-county" },
];

function parseCSVLine(line) {
  const fields = [];
  let cur = "", inQ = false;
  for (const c of line) {
    if (c === '"') { inQ = !inQ; }
    else if (c === "," && !inQ) { fields.push(cur); cur = ""; }
    else cur += c;
  }
  fields.push(cur);
  return fields;
}

// ── Manual CSV Import ─────────────────────────────────────────────────────────
export function loadManualLeads(maxLeads = 50) {
  const csvPath = "leads_import.csv";
  if (!fs.existsSync(csvPath)) return [];

  const lines = fs.readFileSync(csvPath, "utf8").split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].toLowerCase().split(",").map(h => h.trim().replace(/['"]/g, ""));
  const leads = [];

  for (const line of lines.slice(1, maxLeads + 1)) {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || "").trim().replace(/['"]/g, ""));

    const address = obj["address"] || obj["property address"] || obj["situs address"] || "";
    const phone = obj["phone"] || obj["phone number"] || obj["mobile"] || obj["cell"] || "";
    const price = parseInt((obj["price"] || obj["asking price"] || obj["askingprice"] || obj["assessed value"] || "0").replace(/[^0-9]/g, "")) || 0;
    const acreage = parseFloat(obj["acreage"] || obj["acres"] || obj["lot size"] || "0") || null;
    const city = obj["city"] || obj["county"] || "";
    const owner = obj["owner"] || obj["owner name"] || "";

    if (address) {
      leads.push({
        source: "csv_import",
        city,
        address,
        askingPrice: price,
        acreage,
        owner,
        phone: phone.replace(/[^0-9]/g, "") || null,
        email: obj["email"] || null,
        scrapedAt: new Date().toISOString(),
      });
    }
  }

  console.log(`  📄 Loaded ${leads.length} land leads from leads_import.csv`);
  return leads;
}

// ── LandWatch.com scraper ─────────────────────────────────────────────────────
export async function findLandWatchLeads(market, maxLeads = 15) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const leads = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 800 });

    // LandWatch sorted by "Recently Reduced" price — best motivated sellers
    const url = `https://www.landwatch.com/${market.landwatch}/land?sort=3&priceMax=100000&priceMin=5000`;
    console.log(`  🔍 Scraping LandWatch: ${market.name}`);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    const html = await page.content();
    const $ = cheerio.load(html);

    // Extract from JSON-LD schema
    $("script[type='application/ld+json']").each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const items = Array.isArray(data) ? data : [data];
        items.forEach(item => {
          if (item["@type"] === "Product" || item.offers) {
            const price = item.offers?.price || item.price || 0;
            const name = item.name || "";
            if (name && parseInt(price) > 0) {
              leads.push({
                source: "landwatch",
                city: market.name,
                address: name,
                askingPrice: parseInt(price),
                acreage: null,
                url: item.url || null,
                phone: null,
                email: null,
                scrapedAt: new Date().toISOString(),
              });
            }
          }
        });
      } catch { /* skip */ }
    });

    // Fallback: parse listing cards
    if (leads.length === 0) {
      $("[class*=card], [class*=listing], [class*=result], article").slice(0, maxLeads).each((_, el) => {
        const title = $(el).find("h2, h3, [class*=title]").first().text().trim();
        const priceText = $(el).find("[class*=price]").first().text().trim();
        const price = parseInt(priceText.replace(/[^0-9]/g, "")) || 0;
        const acreText = $(el).find("[class*=acre], [class*=size]").first().text().trim();
        const acreMatch = acreText.match(/([\d.]+)\s*acre/i);

        if (title && price > 0) {
          leads.push({
            source: "landwatch",
            city: market.name,
            address: title,
            askingPrice: price,
            acreage: acreMatch ? parseFloat(acreMatch[1]) : null,
            url: $(el).find("a").first().attr("href") || null,
            phone: null,
            email: null,
            scrapedAt: new Date().toISOString(),
          });
        }
      });
    }

    // Get contact info from individual listings
    for (const lead of leads.slice(0, 5)) {
      if (!lead.url) continue;
      try {
        const detailUrl = lead.url.startsWith("http") ? lead.url : `https://www.landwatch.com${lead.url}`;
        await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await new Promise(r => setTimeout(r, 1500));

        const detailHtml = await page.content();
        const $d = cheerio.load(detailHtml);
        const bodyText = $d("body").text();

        // Extract phone
        const phoneMatch = bodyText.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
        if (phoneMatch) lead.phone = phoneMatch[0].replace(/[^0-9]/g, "");

        // Extract acreage if not found
        if (!lead.acreage) {
          const acreMatch = bodyText.match(/([\d.]+)\s*acres?/i);
          if (acreMatch) lead.acreage = parseFloat(acreMatch[1]);
        }

        // Extract description
        lead.description = $d("[class*=description], [class*=details]").first().text()
          .replace(/\s+/g, " ").trim().slice(0, 300);

      } catch { /* skip */ }
      await new Promise(r => setTimeout(r, 800));
    }

  } catch (err) {
    console.log(`    ⚠️  LandWatch ${market.name}: ${err.message.slice(0, 80)}`);
  } finally {
    await browser.close();
  }

  return leads.slice(0, maxLeads);
}

// ── Zillow Lots/Land scraper ──────────────────────────────────────────────────
export async function findZillowLandLeads(market, maxLeads = 15) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const leads = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 800 });

    // Zillow lots/land filter, sorted by days on market (most motivated sellers first)
    const citySlug = market.name.toLowerCase().replace(/,\s*/g, "-").replace(/\s+/g, "-");
    const url = `https://www.zillow.com/${citySlug}/lots--land/?sort=days&price=0-150000`;
    console.log(`  🔍 Scraping Zillow lots: ${market.name}`);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    const html = await page.content();
    const $ = cheerio.load(html);

    // Try __NEXT_DATA__ embedded JSON
    const nextDataEl = $("#__NEXT_DATA__").text();
    if (nextDataEl) {
      try {
        const nextData = JSON.parse(nextDataEl);
        const results =
          nextData?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults || [];
        results.slice(0, maxLeads).forEach(item => {
          const address = item.addressStreet || "";
          const city = item.addressCity || "";
          const state = item.addressState || "";
          const zip = item.addressZipcode || "";
          const price = item.unformattedPrice || 0;
          const zpid = item.zpid;
          const lotSize = item.lotAreaValue || null;

          if (address && price > 0) {
            leads.push({
              source: "zillow",
              city: market.name,
              address: `${address}, ${city}, ${state} ${zip}`.trim(),
              askingPrice: price,
              acreage: lotSize ? parseFloat(lotSize) / 43560 : null, // sq ft → acres
              url: zpid ? `https://www.zillow.com/homedetails/${zpid}_zpid/` : null,
              phone: null,
              email: null,
              scrapedAt: new Date().toISOString(),
            });
          }
        });
      } catch { /* JSON parse failed */ }
    }

    // Fallback: schema.org JSON-LD
    if (leads.length === 0) {
      $("script[type='application/ld+json']").each((_, el) => {
        try {
          const data = JSON.parse($(el).html());
          const items = Array.isArray(data) ? data : [data];
          items.forEach(item => {
            if (item.url?.includes("/homedetails/") && item.name) {
              const price = item.offers?.price || 0;
              if (parseInt(price) > 0) {
                leads.push({
                  source: "zillow",
                  city: market.name,
                  address: item.name,
                  askingPrice: parseInt(price),
                  acreage: null,
                  url: item.url,
                  phone: null,
                  email: null,
                  scrapedAt: new Date().toISOString(),
                });
              }
            }
          });
        } catch { /* skip */ }
      });
    }

  } catch (err) {
    console.log(`    ⚠️  Zillow ${market.name}: ${err.message.slice(0, 80)}`);
  } finally {
    await browser.close();
  }

  return leads.slice(0, maxLeads);
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function findLeads(maxTotal = 20) {
  // 1. Check for manual CSV import first (fastest, best data)
  const manualLeads = loadManualLeads(maxTotal);
  if (manualLeads.length > 0) {
    console.log(`\n🌿 Using ${manualLeads.length} leads from CSV import`);
    return manualLeads.slice(0, maxTotal);
  }

  // 2. Scrape LandWatch across 2 random markets
  const shuffled = [...MARKETS].sort(() => Math.random() - 0.5);
  const marketsToTry = shuffled.slice(0, 2);

  console.log(`\n🌿 Finding vacant land deals...`);
  console.log(`   Markets: ${marketsToTry.map(m => m.name).join(", ")}`);

  const allLeads = [];

  for (const market of marketsToTry) {
    if (allLeads.length >= maxTotal) break;
    const perMarket = Math.ceil((maxTotal - allLeads.length) / marketsToTry.length);

    // Try LandWatch first
    let leads = await findLandWatchLeads(market, perMarket);

    // Fallback to Zillow if LandWatch finds nothing
    if (leads.length === 0) {
      leads = await findZillowLandLeads(market, perMarket);
    }

    allLeads.push(...leads);
    console.log(`  Found ${leads.length} leads in ${market.name} (total: ${allLeads.length})`);
    await new Promise(r => setTimeout(r, 1500));
  }

  if (allLeads.length === 0) {
    console.log(`
  ⚠️  No leads scraped. Best free sources for land leads:
     1. County assessor/treasurer sites → search "vacant land" → export CSV
     2. landwatch.com → filter your county → manually copy listings
     3. Zillow → Lots/Land filter → Days on Market → save as leads_import.csv
     Required CSV columns: address, phone, askingPrice, acreage (optional)
`);
  }

  return allLeads.slice(0, maxTotal);
}
