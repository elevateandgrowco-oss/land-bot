/**
 * lead_finder.js
 * Finds motivated vacant land sellers from ALL sources:
 * 1. BatchData property lists  — tax delinquent land, absentee land owners, vacant parcels
 * 2. Craigslist                — land for sale by owner
 * 3. LandWatch.com             — FSBO land listings
 * 4. Land.com / Lands of America — FSBO land listings
 * 5. Facebook Marketplace      — FSBO land
 * 6. Foreclosure land          — bank-owned and pre-foreclosure land
 * 7. Manual CSV import         — your own list (always included)
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

const BATCH_API_KEY = process.env.BATCH_SKIP_TRACING_API_KEY;

// ── Target markets ────────────────────────────────────────────────────────────
const MARKETS = [
  { name: "Austin, TX",        city: "Austin",        state: "TX", cl: "austin",        lw: "texas/travis-county" },
  { name: "Nashville, TN",     city: "Nashville",     state: "TN", cl: "nashville",     lw: "tennessee/davidson-county" },
  { name: "Charlotte, NC",     city: "Charlotte",     state: "NC", cl: "charlotte",     lw: "north-carolina/mecklenburg-county" },
  { name: "Phoenix, AZ",       city: "Phoenix",       state: "AZ", cl: "phoenix",       lw: "arizona/maricopa-county" },
  { name: "Tampa, FL",         city: "Tampa",         state: "FL", cl: "tampa",         lw: "florida/hillsborough-county" },
  { name: "Atlanta, GA",       city: "Atlanta",       state: "GA", cl: "atlanta",       lw: "georgia/fulton-county" },
  { name: "Dallas, TX",        city: "Dallas",        state: "TX", cl: "dallas",        lw: "texas/dallas-county" },
  { name: "Raleigh, NC",       city: "Raleigh",       state: "NC", cl: "raleigh",       lw: "north-carolina/wake-county" },
  { name: "Jacksonville, FL",  city: "Jacksonville",  state: "FL", cl: "jacksonville",  lw: "florida/duval-county" },
  { name: "San Antonio, TX",   city: "San Antonio",   state: "TX", cl: "sanantonio",    lw: "texas/bexar-county" },
  { name: "Orlando, FL",       city: "Orlando",       state: "FL", cl: "orlando",       lw: "florida/orange-county" },
  { name: "Houston, TX",       city: "Houston",       state: "TX", cl: "houston",       lw: "texas/harris-county" },
  { name: "Columbus, OH",      city: "Columbus",      state: "OH", cl: "columbus",      lw: "ohio/franklin-county" },
  { name: "Indianapolis, IN",  city: "Indianapolis",  state: "IN", cl: "indianapolis",  lw: "indiana/marion-county" },
  { name: "Denver, CO",        city: "Denver",        state: "CO", cl: "denver",        lw: "colorado/denver-county" },
  { name: "Ocala, FL",         city: "Ocala",         state: "FL", cl: "gainesville",   lw: "florida/marion-county" },
  { name: "Knoxville, TN",     city: "Knoxville",     state: "TN", cl: "knoxville",     lw: "tennessee/knox-county" },
  { name: "Huntsville, AL",    city: "Huntsville",    state: "AL", cl: "huntsville",    lw: "alabama/madison-county" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function extractAcreage(text) {
  const match = text.match(/([\d.]+)\s*acres?/i);
  return match ? parseFloat(match[1]) : null;
}

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

function dedup(leads) {
  const seen = new Set();
  return leads.filter(l => {
    const key = (l.phone || l.address || "").replace(/\D/g, "").slice(-10);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── 1. CSV Import ─────────────────────────────────────────────────────────────
export function loadManualLeads(maxLeads = 100) {
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
    const price = parseInt((obj["price"] || obj["asking price"] || obj["assessed value"] || "0").replace(/[^0-9]/g, "")) || 0;
    const acreage = parseFloat(obj["acreage"] || obj["acres"] || obj["lot size"] || "0") || null;
    if (address) {
      leads.push({
        source: "csv_import",
        city: obj["city"] || obj["county"] || "",
        address,
        askingPrice: price,
        acreage,
        phone: phone.replace(/[^0-9]/g, "") || null,
        email: obj["email"] || null,
        ownerName: obj["owner"] || obj["name"] || null,
        motivation: obj["motivation"] || obj["list type"] || "csv",
        scrapedAt: new Date().toISOString(),
      });
    }
  }
  if (leads.length) console.log(`  📄 CSV import: ${leads.length} leads`);
  return leads;
}

// ── 2. BatchData Vacant Land Lists ────────────────────────────────────────────
async function findBatchDataLandLeads(market, filterType, maxLeads = 20) {
  if (!BATCH_API_KEY) return [];

  const filterPresets = {
    taxDelinquent:  { taxDelinquent: true, propertyType: ["Vacant Land", "Agricultural", "Lot"] },
    absenteeOwner:  { ownerOccupied: false, absenteeOwner: true, propertyType: ["Vacant Land", "Agricultural", "Lot"] },
    vacantParcel:   { vacant: true, propertyType: ["Vacant Land", "Agricultural", "Lot"] },
    longTimeOwner:  { yearsOwned: { min: 10 }, propertyType: ["Vacant Land", "Agricultural", "Lot"] },
  };

  const filters = filterPresets[filterType] || {};

  try {
    const res = await axios.post(
      "https://api.batchdata.com/api/v1/property/search",
      {
        data: {
          filters: {
            state: market.state,
            city: market.city,
            maxValue: 200000,
            ...filters,
          },
          options: { size: maxLeads, page: 0 },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${BATCH_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const results = res.data?.data?.results || res.data?.results || res.data?.properties || [];
    const leads = results.map(p => ({
      source: `batchdata_${filterType}`,
      motivation: filterType,
      city: market.name,
      address: [p.propertyAddress, p.propertyCity, p.propertyState].filter(Boolean).join(", ") || p.address || "",
      askingPrice: p.estimatedValue || p.avm || p.assessedValue || 0,
      acreage: p.lotSizeAcres || p.acreage || null,
      ownerName: [p.ownerFirstName, p.ownerLastName].filter(Boolean).join(" ") || null,
      phone: null,
      email: p.ownerEmail || null,
      scrapedAt: new Date().toISOString(),
    })).filter(l => l.address);

    if (leads.length) console.log(`  🏦 BatchData ${filterType} (${market.name}): ${leads.length} land parcels`);
    return leads;

  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 401) {
      console.log(`  ⚠️  BatchData property search not enabled on your plan — skipping list pull`);
    } else {
      console.log(`  ⚠️  BatchData ${filterType}: ${(err.response?.data?.message || err.message)?.slice(0, 80)}`);
    }
    return [];
  }
}

// ── 3. Craigslist Land (Puppeteer — JS rendering required) ───────────────────
export async function findCraigslistLandLeads(market, maxLeads = 10) {
  const leads = [];
  let browser;
  try {
    const queries = ["land for sale", "vacant lot", "acres for sale", "land owner financing"];
    const query = queries[Math.floor(Math.random() * queries.length)];
    console.log(`  🔍 Craigslist land: ${market.name} ("${query}")`);

    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    const searchUrl = `https://${market.cl}.craigslist.org/search/rea?srchType=T&max_price=150000&query=${encodeURIComponent(query)}&sort=priceasc`;
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const content = await page.content();
    const $ = cheerio.load(content);

    const listingUrls = [];
    $("a[href*='/rea/']").each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (href && /\b(land|lot|acre|parcel|vacant|plot|farm|ranch)\b/i.test(text) && !listingUrls.includes(href)) {
        const fullUrl = href.startsWith("http") ? href : `https://${market.cl}.craigslist.org${href}`;
        listingUrls.push(fullUrl);
      }
    });

    console.log(`    Found ${listingUrls.length} land listings, extracting contact info...`);

    for (const url of listingUrls.slice(0, maxLeads * 2)) {
      if (leads.length >= maxLeads) break;
      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
        await new Promise(r => setTimeout(r, 1000));
        const detailContent = await page.content();
        const $d = cheerio.load(detailContent);
        const bodyText = $d("#postingbody, .posting-body, body").text();
        const phone = extractPhone(bodyText);
        const acreage = extractAcreage(bodyText) || extractAcreage($d("h1").text());
        const price = parseInt($d(".price, [class*=price]").first().text().replace(/[^0-9]/g, "")) || 0;
        const address = $d(".mapaddress, [class*=mapaddress]").text().trim() || $d("h1, .postingtitletext").text().trim();
        if (address && address.length > 5) {
          leads.push({ source: "craigslist", city: market.name, address, askingPrice: price, acreage, phone: phone || null, motivation: "fsbo", scrapedAt: new Date().toISOString() });
          console.log(`    ✓ ${address.slice(0, 40)} | ${acreage ? acreage + " acres" : "?"} | ${phone || "no phone — will skip trace"}`);
        }
        await new Promise(r => setTimeout(r, 1000));
      } catch { /* skip */ }
    }
    if (leads.length) console.log(`  ✓ Craigslist ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  Craigslist ${market.name}: ${err.message.slice(0, 60)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return leads;
}

// ── 4. Zillow Land/Lot FSBO ───────────────────────────────────────────────────
async function findZillowLandLeads(market, maxLeads = 15) {
  const leads = [];
  let browser;
  try {
    console.log(`  🏠 Zillow land: ${market.name}`);
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    const citySlug = market.city.toLowerCase().replace(/\s+/g, "-");
    const stateSlug = market.state.toLowerCase();
    // lot-land filter on Zillow
    const url = `https://www.zillow.com/${citySlug}-${stateSlug}/lot-land/`;

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const content = await page.content();
    const $ = cheerio.load(content);

    // Extract from Zillow's JSON embed
    const scriptTags = $("script[type='application/json'], script#__NEXT_DATA__").toArray();
    for (const script of scriptTags) {
      try {
        const json = JSON.parse($(script).html() || "{}");
        const searchResults = JSON.stringify(json).match(/"zpid":\d+.*?"address":\{[^}]+\}/g) || [];
        for (const match of searchResults.slice(0, maxLeads)) {
          try {
            const obj = JSON.parse(`{${match}}`);
            if (obj.address?.streetAddress) {
              leads.push({
                source: "zillow_land",
                city: market.name,
                address: `${obj.address.streetAddress}, ${obj.address.city || market.city}, ${obj.address.state || market.state}`,
                askingPrice: obj.price || 0,
                acreage: null,
                phone: null,
                motivation: "fsbo",
                scrapedAt: new Date().toISOString(),
              });
            }
          } catch { /* skip */ }
        }
      } catch { /* not json */ }
    }

    // Fallback: scrape visible cards
    if (leads.length === 0) {
      $("[data-test='property-card'], .list-card, article").each((_, el) => {
        const address = $(el).find("address, [data-test='property-card-addr']").text().trim();
        const priceText = $(el).find("[data-test='property-card-price'], .list-card-price").text().trim();
        const price = parseInt(priceText.replace(/[^0-9]/g, "")) || 0;
        if (address && leads.length < maxLeads) {
          leads.push({ source: "zillow_land", city: market.name, address, askingPrice: price, acreage: null, phone: null, motivation: "fsbo", scrapedAt: new Date().toISOString() });
        }
      });
    }

    if (leads.length) console.log(`  ✓ Zillow land ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  Zillow land ${market.name}: ${err.message.slice(0, 60)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return leads.slice(0, maxLeads);
}

// ── 5. Realtor.com Land ───────────────────────────────────────────────────────
async function findRealtorLandLeads(market, maxLeads = 12) {
  const leads = [];
  let browser;
  try {
    console.log(`  🏡 Realtor.com land: ${market.name}`);
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    const cityState = `${market.city}_${market.state}`.replace(/\s+/g, "_");
    const url = `https://www.realtor.com/realestateandhomes-search/${cityState}/type-land/price-na-200000`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const content = await page.content();
    const $ = cheerio.load(content);

    // Extract from Realtor.com JSON embed
    $("script[type='application/ld+json']").each((_, el) => {
      try {
        const data = JSON.parse($(el).html() || "{}");
        const items = data["@graph"] || (Array.isArray(data) ? data : [data]);
        for (const item of items) {
          if (leads.length >= maxLeads) break;
          const address = item?.address;
          if (address?.streetAddress) {
            leads.push({
              source: "realtor_com_land",
              city: market.name,
              address: `${address.streetAddress}, ${address.addressLocality || market.city}, ${address.addressRegion || market.state}`,
              askingPrice: parseInt((item.offers?.price || "0").toString().replace(/[^0-9]/g, "")) || 0,
              acreage: null,
              phone: null,
              motivation: "fsbo",
              scrapedAt: new Date().toISOString(),
            });
          }
        }
      } catch { /* skip */ }
    });

    // Fallback: visible cards
    if (leads.length === 0) {
      $("[data-testid='card-content'], [class*=BasePropertyCard], li[data-testid]").each((_, el) => {
        if (leads.length >= maxLeads) return;
        const addr = $(el).find("[data-testid='card-address'], [class*=address]").text().trim();
        const priceText = $(el).find("[data-testid='card-price'], [class*=price]").text().trim();
        const price = parseInt(priceText.replace(/[^0-9]/g, "")) || 0;
        if (addr && addr.length > 5) {
          leads.push({ source: "realtor_com_land", city: market.name, address: `${addr}, ${market.city}, ${market.state}`, askingPrice: price, acreage: null, phone: null, motivation: "fsbo", scrapedAt: new Date().toISOString() });
        }
      });
    }

    if (leads.length) console.log(`  ✓ Realtor.com land ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  Realtor.com land ${market.name}: ${err.message.slice(0, 60)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return leads.slice(0, maxLeads);
}

// ── 6. Facebook Marketplace Land ─────────────────────────────────────────────
async function findFacebookLandLeads(market, maxLeads = 8) {
  const leads = [];
  let browser;
  try {
    console.log(`  📘 Facebook Marketplace land: ${market.name}`);
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    const url = `https://www.facebook.com/marketplace/${market.city.toLowerCase().replace(/\s/g, "")}/propertyforsale?query=land%20for%20sale%20acres&sortBy=creation_time_descend`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const content = await page.content();
    const $ = cheerio.load(content);
    $("[data-testid='marketplace_feed_unit'], div[role='article']").each((_, el) => {
      if (leads.length >= maxLeads) return;
      const text = $(el).text();
      const isLand = /\b(land|acre|lot|parcel|vacant)\b/i.test(text);
      if (!isLand) return;
      const priceMatch = text.match(/\$[\d,]+/);
      const price = priceMatch ? parseInt(priceMatch[0].replace(/[^0-9]/g, "")) : 0;
      const acreage = extractAcreage(text);
      const phone = extractPhone(text);
      if (price > 0 && price < 200000) {
        leads.push({ source: "facebook_marketplace", city: market.name, address: `${market.city}, ${market.state}`, askingPrice: price, acreage, phone: phone || null, motivation: "fsbo", scrapedAt: new Date().toISOString() });
      }
    });
    if (leads.length) console.log(`  ✓ Facebook ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  Facebook ${market.name}: ${err.message.slice(0, 60)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return leads.slice(0, maxLeads);
}

// ── 7. Redfin Price-Reduced Land ──────────────────────────────────────────────
async function findRedfinLandLeads(market, maxLeads = 12) {
  const leads = [];
  let browser;
  try {
    console.log(`  🔴 Redfin price-reduced land: ${market.name}`);
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    const citySlug = market.city.toLowerCase().replace(/\s+/g, "-");
    const url = `https://www.redfin.com/${market.state}/${citySlug}/filter/property-type=land,max-price=200000,price-reduced=true,sort=lo-days`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const content = await page.content();
    const $ = cheerio.load(content);

    const dataScript = $("script").filter((_, el) => $(el).html()?.includes('"streetLine"')).first().html() || "";
    const matches = dataScript.match(/"streetLine":"([^"]+)","city":"([^"]+)","state":"([^"]+)"/g) || [];
    for (const match of matches.slice(0, maxLeads)) {
      const parts = match.match(/"streetLine":"([^"]+)","city":"([^"]+)","state":"([^"]+)"/);
      if (parts) {
        leads.push({ source: "redfin_price_reduced", motivation: "price_reduced", city: market.name, address: `${parts[1]}, ${parts[2]}, ${parts[3]}`, askingPrice: 0, acreage: null, phone: null, scrapedAt: new Date().toISOString() });
      }
    }

    if (leads.length === 0) {
      $("[data-rf-test-id='abp-streetLine'], .homeAddress").each((_, el) => {
        if (leads.length >= maxLeads) return;
        const street = $(el).text().trim();
        if (street && /\d/.test(street)) {
          leads.push({ source: "redfin_price_reduced", motivation: "price_reduced", city: market.name, address: `${street}, ${market.city}, ${market.state}`, askingPrice: 0, acreage: null, phone: null, scrapedAt: new Date().toISOString() });
        }
      });
    }

    if (leads.length) console.log(`  ✓ Redfin land ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  Redfin ${market.name}: ${err.message.slice(0, 60)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return leads.slice(0, maxLeads);
}

// ── 8. Auction.com — Distressed Land ─────────────────────────────────────────
async function findAuctionLandLeads(market, maxLeads = 10) {
  const leads = [];
  try {
    console.log(`  🔨 Auction.com land: ${market.name}`);
    const url = `https://www.auction.com/land/?state=${market.state}&city=${encodeURIComponent(market.city)}`;
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    });
    const $ = cheerio.load(res.data);
    $("script").each((_, el) => {
      if (leads.length >= maxLeads) return;
      const text = $(el).html() || "";
      if (!text.includes("streetAddress")) return;
      const matches = text.match(/"streetAddress":"([^"]+)","addressLocality":"([^"]+)","addressRegion":"([^"]+)"/g) || [];
      for (const m of matches) {
        if (leads.length >= maxLeads) break;
        const parts = m.match(/"streetAddress":"([^"]+)","addressLocality":"([^"]+)","addressRegion":"([^"]+)"/);
        if (parts) {
          leads.push({ source: "auction_com", motivation: "bank_owned_land", city: market.name, address: `${parts[1]}, ${parts[2]}, ${parts[3]}`, askingPrice: 0, acreage: null, phone: null, scrapedAt: new Date().toISOString() });
        }
      }
    });
    if (leads.length) console.log(`  ✓ Auction.com land ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  Auction.com ${market.name}: ${err.message.slice(0, 60)}`);
  }
  return leads;
}

// ── 9. County Tax Delinquent Land Lists (free public record) ─────────────────
// Best land leads — owners drowning in taxes on land they forgot they had
async function findTaxDelinquentLandLeads(market, maxLeads = 20) {
  const leads = [];
  try {
    console.log(`  📋 Tax delinquent land: ${market.name}`);

    // State-level tax sale / delinquent land databases
    const stateSources = {
      "TX": `https://www.mvba.com/delinquent-tax-sales/?state=TX`,
      "FL": `https://www.bidspotter.com/en-us/auction-catalogues?keywords=tax+certificate+${market.city}+land`,
      "GA": `https://www.fultoncountytaxes.org/property/delinquent-tax-sales`,
      "TN": `https://www.tennessee.gov/revenue/taxes/property-taxes.html`,
      "NC": `https://www.ncdor.gov/taxes-forms/real-property-tax/property-tax-publications/tax-foreclosure`,
      "AZ": `https://treasurer.maricopa.gov/parcels/tax-delinquent`,
      "CO": `https://www.denvergov.org/Government/Agencies-Departments-Offices/Agencies-Departments-Offices-Directory/Treasury`,
      "IN": `https://www.in.gov/dlgf/8073.htm`,
      "OH": `https://www.ohiopublicauctions.com/`,
    };

    const stateUrl = stateSources[market.state];
    if (stateUrl) {
      try {
        const res = await axios.get(stateUrl, {
          timeout: 12000,
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
        });
        const $ = cheerio.load(res.data);
        $("table tr, [class*=result], [class*=parcel], [class*=property]").each((_, el) => {
          if (leads.length >= maxLeads) return;
          const text = $(el).text();
          const isLand = /\b(land|lot|acre|parcel|vacant|rural|farm)\b/i.test(text);
          const address = text.match(/\d+\s+[A-Za-z\s]+(St|Ave|Rd|Dr|Blvd|Way|Ln|Ct|Pl|Hwy|Rte|Route)\b/i)?.[0];
          if (address && isLand) {
            leads.push({ source: "tax_delinquent_land", motivation: "taxDelinquent", city: market.name, address: `${address}, ${market.city}, ${market.state}`, askingPrice: 0, acreage: extractAcreage(text), phone: null, scrapedAt: new Date().toISOString() });
          }
        });
      } catch { /* county site not accessible */ }
    }

    // Bonus: GovSales.gov — federal surplus land (always free)
    try {
      const govRes = await axios.get(
        `https://www.govsales.gov/sales/search?q=${encodeURIComponent(market.state + " land")}&type=real_property`,
        { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } }
      );
      const $g = cheerio.load(govRes.data);
      $g("[class*=address], [class*=location], .sale-address").each((_, el) => {
        if (leads.length >= maxLeads) return;
        const address = $g(el).text().trim();
        if (address && /\d/.test(address)) {
          leads.push({ source: "gov_surplus_land", motivation: "government_surplus", city: market.name, address, askingPrice: 0, acreage: null, phone: null, scrapedAt: new Date().toISOString() });
        }
      });
    } catch { /* skip */ }

    if (leads.length) console.log(`  ✓ Tax delinquent land ${market.name}: ${leads.length} leads`);
    else console.log(`  ℹ️  Tax delinquent land: county sites vary — drop CSV for guaranteed coverage`);
  } catch (err) {
    console.log(`  ⚠️  Tax delinquent ${market.name}: ${err.message.slice(0, 60)}`);
  }
  return leads;
}

// ── 10. Lands of America / LoopNet FSBO Land ─────────────────────────────────
async function findLoaLeads(market, maxLeads = 10) {
  const leads = [];
  try {
    console.log(`  🌾 Lands of America: ${market.name}`);
    const stateSlug = market.state.toLowerCase();
    const url = `https://www.landsofamerica.com/land/for-sale/${stateSlug}/?city=${encodeURIComponent(market.city)}&maxPrice=200000&hasSellerFinancing=true`;
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    });
    const $ = cheerio.load(res.data);
    $("[class*=listingCard], [class*=property], article, [class*=listing]").each((_, el) => {
      if (leads.length >= maxLeads) return;
      const address = $(el).find("[class*=title], [class*=address], h3, h2").first().text().trim();
      const priceText = $(el).find("[class*=price]").first().text().trim();
      const price = parseInt(priceText.replace(/[^0-9]/g, "")) || 0;
      const acreage = extractAcreage($(el).text());
      const phone = extractPhone($(el).text());
      if (address && address.length > 3) {
        leads.push({ source: "lands_of_america", motivation: "fsbo_owner_finance", city: market.name, address, askingPrice: price, acreage, phone: phone || null, scrapedAt: new Date().toISOString() });
      }
    });
    if (leads.length) console.log(`  ✓ Lands of America ${market.name}: ${leads.length} leads`);
  } catch (err) {
    console.log(`  ⚠️  Lands of America ${market.name}: ${err.message.slice(0, 60)}`);
  }
  return leads;
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function findLeads(maxTotal = 30) {
  console.log(`\n🌿 Finding motivated land seller leads from all sources...`);

  const allLeads = [];

  // Always include CSV leads
  const csvLeads = loadManualLeads(50);
  allLeads.push(...csvLeads);

  // Pick random markets for this run
  const shuffled = [...MARKETS].sort(() => Math.random() - 0.5);
  const markets = shuffled.slice(0, 3);
  const market = markets[0];

  console.log(`\n   Markets this run: ${markets.map(m => m.name).join(", ")}`);

  const [
    taxDelinquentLeads,
    craigslistLeads,
    zillowLeads,
    realtorLeads,
    loaLeads,
    redfinLeads,
    auctionLeads,
    facebookLeads,
  ] = await Promise.allSettled([
    findTaxDelinquentLandLeads(market, 15),
    findCraigslistLandLeads(market, 8),
    findZillowLandLeads(markets[1] || market, 15),
    findRealtorLandLeads(markets[2] || market, 12),
    findLoaLeads(markets[1] || market, 10),
    findRedfinLandLeads(markets[2] || market, 10),
    findAuctionLandLeads(market, 8),
    findFacebookLandLeads(markets[1] || market, 8),
  ]);

  for (const result of [taxDelinquentLeads, craigslistLeads, zillowLeads, realtorLeads, loaLeads, redfinLeads, auctionLeads, facebookLeads]) {
    if (result.status === "fulfilled") allLeads.push(...(result.value || []));
  }

  console.log(`\n📊 Raw leads collected: ${allLeads.length} (before dedup + skip trace)`);

  const unique = dedup(allLeads);
  console.log(`   After dedup: ${unique.length}`);

  const withPhones = await skipTraceLeads(unique);
  console.log(`   After skip trace: ${withPhones.length} with phone numbers`);

  const priority = { tax_delinquent_land: 0, gov_surplus_land: 1, auction_com: 2, redfin_price_reduced: 3, zillow_land: 4, realtor_com_land: 5, lands_of_america: 6, craigslist: 7, facebook_marketplace: 8, csv_import: 9 };
  withPhones.sort((a, b) => (priority[a.source] ?? 99) - (priority[b.source] ?? 99));

  return withPhones.slice(0, maxTotal);
}
