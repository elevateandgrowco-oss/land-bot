/**
 * lead_finder.js
 * Finds vacant land leads from:
 * 1. Manual CSV import (primary)
 * 2. Craigslist "land for sale" listings (sellers post their phone in listing)
 * 3. LandWatch.com (addresses only, no phones)
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as cheerio from "cheerio";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
import { skipTraceLeads } from "./skip_tracer.js";
dotenv.config();

puppeteer.use(StealthPlugin());

// Craigslist cities for land search
const MARKETS = [
  { name: "Austin, TX",        cl: "austin",        landwatch: "texas/travis-county" },
  { name: "Nashville, TN",     cl: "nashville",     landwatch: "tennessee/davidson-county" },
  { name: "Charlotte, NC",     cl: "charlotte",     landwatch: "north-carolina/mecklenburg-county" },
  { name: "Phoenix, AZ",       cl: "phoenix",       landwatch: "arizona/maricopa-county" },
  { name: "Tampa, FL",         cl: "tampa",         landwatch: "florida/hillsborough-county" },
  { name: "Atlanta, GA",       cl: "atlanta",       landwatch: "georgia/fulton-county" },
  { name: "Dallas, TX",        cl: "dallas",        landwatch: "texas/dallas-county" },
  { name: "Raleigh, NC",       cl: "raleigh",       landwatch: "north-carolina/wake-county" },
  { name: "Jacksonville, FL",  cl: "jacksonville",  landwatch: "florida/duval-county" },
  { name: "San Antonio, TX",   cl: "sanantonio",    landwatch: "texas/bexar-county" },
  { name: "Orlando, FL",       cl: "orlando",       landwatch: "florida/orange-county" },
  { name: "Houston, TX",       cl: "houston",       landwatch: "texas/harris-county" },
  { name: "Columbus, OH",      cl: "columbus",      landwatch: "ohio/franklin-county" },
  { name: "Indianapolis, IN",  cl: "indianapolis",  landwatch: "indiana/marion-county" },
  { name: "Denver, CO",        cl: "denver",        landwatch: "colorado/denver-county" },
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

// ── Extract phone number from text ────────────────────────────────────────────
function extractPhone(text) {
  const matches = text.match(/(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/g);
  if (!matches) return null;
  for (const m of matches) {
    const digits = m.replace(/\D/g, "");
    if (digits.length === 10 && !digits.startsWith("000")) return digits;
    if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  }
  return null;
}

// ── Extract acreage from text ─────────────────────────────────────────────────
function extractAcreage(text) {
  const match = text.match(/([\d.]+)\s*acres?/i);
  return match ? parseFloat(match[1]) : null;
}

// ── Craigslist land scraper ───────────────────────────────────────────────────
export async function findCraigslistLandLeads(market, maxLeads = 10) {
  const leads = [];

  try {
    // Search Craigslist real estate for land/lot listings
    const queries = ["land for sale", "vacant lot", "acres for sale"];
    const query = queries[Math.floor(Math.random() * queries.length)];
    const searchUrl = `https://${market.cl}.craigslist.org/search/rea?srchType=T&max_price=150000&query=${encodeURIComponent(query)}&sort=priceasc`;

    console.log(`  🔍 Craigslist land: ${market.name} ("${query}")`);

    const res = await axios.get(searchUrl, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });

    const $ = cheerio.load(res.data);
    const listings = [];

    $("li.cl-search-result, .result-row, li[class*=result]").each((_, el) => {
      const link = $(el).find("a[href*='/rea/'], a.posting-title").attr("href");
      const title = $(el).find(".posting-title, a.posting-title, .result-title").text().trim();
      const priceText = $(el).find(".priceinfo, .result-price").text().trim();
      const price = parseInt(priceText.replace(/[^0-9]/g, "")) || 0;

      if (link && title) {
        const fullUrl = link.startsWith("http") ? link : `https://${market.cl}.craigslist.org${link}`;
        // Filter for land-related titles
        const isLand = /\b(land|lot|acre|parcel|vacant|plot|farm|ranch)\b/i.test(title);
        if (isLand) listings.push({ url: fullUrl, title, price });
      }
    });

    // Newer Craigslist markup fallback
    if (listings.length === 0) {
      $("a.posting-title, .cl-app-anchor").each((_, el) => {
        const link = $(el).attr("href");
        const title = $(el).text().trim();
        if (link && title) {
          const isLand = /\b(land|lot|acre|parcel|vacant|plot|farm|ranch)\b/i.test(title);
          if (isLand) {
            const fullUrl = link.startsWith("http") ? link : `https://${market.cl}.craigslist.org${link}`;
            listings.push({ url: fullUrl, title, price: 0 });
          }
        }
      });
    }

    console.log(`    Found ${listings.length} land listings, extracting contact info...`);

    for (const listing of listings.slice(0, maxLeads * 2)) {
      if (leads.length >= maxLeads) break;

      try {
        const detailRes = await axios.get(listing.url, {
          timeout: 10000,
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
        });

        const $d = cheerio.load(detailRes.data);
        const bodyText = $d("#postingbody, .posting-body, body").text();
        const phone = extractPhone(bodyText);

        let price = listing.price;
        if (!price) {
          const priceMatch = $d(".price, [class*=price]").first().text();
          price = parseInt(priceMatch.replace(/[^0-9]/g, "")) || 0;
        }

        const acreage = extractAcreage(bodyText) || extractAcreage(listing.title);
        const mapAddress = $d(".mapaddress, [class*=mapaddress]").text().trim();
        const address = mapAddress || listing.title;

        if (phone) {
          leads.push({
            source: "craigslist",
            city: market.name,
            address,
            askingPrice: price,
            acreage,
            phone,
            url: listing.url,
            email: null,
            scrapedAt: new Date().toISOString(),
          });
          console.log(`    ✓ Found: ${address} | ${acreage ? acreage + ' acres' : 'unknown acres'} | $${price.toLocaleString()} | ${phone}`);
        }

        await new Promise(r => setTimeout(r, 800));

      } catch { /* skip */ }
    }

  } catch (err) {
    console.log(`    ⚠️  Craigslist ${market.name}: ${err.message.slice(0, 80)}`);
  }

  return leads.slice(0, maxLeads);
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function findLeads(maxTotal = 20) {
  // 1. Check for manual CSV import first
  const manualLeads = loadManualLeads(maxTotal);
  if (manualLeads.length > 0) {
    console.log(`\n🌿 Using ${manualLeads.length} leads from CSV import`);
    return manualLeads.slice(0, maxTotal);
  }

  // 2. Scrape Craigslist land listings across random markets
  const shuffled = [...MARKETS].sort(() => Math.random() - 0.5);
  const marketsToTry = shuffled.slice(0, 4);

  console.log(`\n🌿 Finding vacant land leads on Craigslist...`);
  console.log(`   Markets: ${marketsToTry.map(m => m.name).join(", ")}`);

  const allLeads = [];

  for (const market of marketsToTry) {
    if (allLeads.length >= maxTotal) break;
    const perMarket = Math.ceil((maxTotal - allLeads.length) / marketsToTry.length);
    const leads = await findCraigslistLandLeads(market, perMarket);
    allLeads.push(...leads);
    console.log(`  Found ${leads.length} leads with phones in ${market.name} (total: ${allLeads.length})`);
    await new Promise(r => setTimeout(r, 2000));
  }

  // 3. Skip trace any leads missing phone numbers
  const leadsWithPhones = await skipTraceLeads(allLeads);

  if (leadsWithPhones.length === 0) {
    console.log(`
  ⚠️  No land leads with phone numbers found.
     Add BATCH_SKIP_TRACING_API_KEY to your .env file to enable automatic phone lookup.
     Sign up at batchskiptracing.com (~$0.18/record)
`);
  }

  return leadsWithPhones.slice(0, maxTotal);
}
