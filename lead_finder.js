/**
 * lead_finder.js — New Construction Adjacent Strategy
 *
 * Strategy (from video):
 * 1. Find where builders are actively building right now (Google Maps)
 * 2. Pull vacant lot owners near that construction (BatchData)
 * 3. Text them a cash offer they weren't expecting
 *
 * Why this beats FSBO scraping:
 * - Owners aren't trying to sell = no competition
 * - Builder demand is already proven (they're building next door)
 * - Owner bought the lot for $8K in 2005, you offer $25K = they think it's a windfall
 * - You assign to the builder next door for $40K = $15K profit
 */

import * as cheerio from "cheerio";
import axios from "axios";
import fs from "fs";

// ── Robust Zillow listing extractor ──────────────────────────────────────────
// Zillow embeds all listing data in __NEXT_DATA__. We walk the JSON tree
// to find arrays of objects with address.streetAddress instead of fragile regex.
function extractZillowListings(html) {
  const $ = cheerio.load(html);
  const found = [];

  const nextData = $("script#__NEXT_DATA__").html();
  if (nextData) {
    try {
      const parsed = JSON.parse(nextData);
      function dig(obj) {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          if (obj.length > 0 && (obj[0]?.address?.streetAddress || obj[0]?.streetAddress)) {
            found.push(...obj);
            return;
          }
          obj.forEach(dig);
          return;
        }
        for (const key of ["listResults", "relaxedResults", "mapResults", "results", "homes", "listings"]) {
          if (obj[key]) { dig(obj[key]); if (found.length) return; }
        }
        if (!found.length) Object.values(obj).forEach(v => { if (!found.length) dig(v); });
      }
      dig(parsed);
    } catch { /* ignore parse errors */ }
  }

  // Fallback: visible property cards
  if (found.length === 0) {
    $("[data-test='property-card'], article").each((_, el) => {
      const address = $(el).find("address, [data-test='property-card-addr']").text().trim();
      const price = parseInt($(el).find("[data-test='property-card-price']").text().replace(/[^0-9]/g, "")) || 0;
      if (address && address.length > 5) found.push({ address, price });
    });
  }

  return found;
}
import dotenv from "dotenv";
import { skipTraceLeads } from "./skip_tracer.js";
import { findCountyRecordLeads } from "./county_records.js";
dotenv.config();

// Lazy-load puppeteer so the HTTP server starts without heavy module init
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

const BATCH_API_KEY = process.env.BATCH_SKIP_TRACING_API_KEY;

// ── Builder-hot markets: TX, FL, NC, TN, AZ, ID, SC, AL, CO, NV, GA ──────────
// These are the fastest-growing suburban/exurban areas where builders are active
const MARKETS = [
  // Texas
  { name: "Frisco, TX",          city: "Frisco",          state: "TX", zip: ["75033", "75034", "75035"] },
  { name: "McKinney, TX",        city: "McKinney",        state: "TX", zip: ["75069", "75070", "75071"] },
  { name: "New Braunfels, TX",   city: "New Braunfels",   state: "TX", zip: ["78130", "78132"] },
  { name: "Kyle, TX",            city: "Kyle",            state: "TX", zip: ["78640"] },
  { name: "Pflugerville, TX",    city: "Pflugerville",    state: "TX", zip: ["78660", "78664"] },
  { name: "Katy, TX",            city: "Katy",            state: "TX", zip: ["77494", "77493", "77450"] },
  { name: "Conroe, TX",          city: "Conroe",          state: "TX", zip: ["77384", "77385", "77304"] },
  { name: "Aubrey, TX",          city: "Aubrey",          state: "TX", zip: ["76227"] },
  { name: "Little Elm, TX",      city: "Little Elm",      state: "TX", zip: ["75068"] },
  { name: "Celina, TX",          city: "Celina",          state: "TX", zip: ["75009"] },

  // Florida
  { name: "Port St. Lucie, FL",  city: "Port St. Lucie",  state: "FL", zip: ["34953", "34986", "34987"] },
  { name: "Land O Lakes, FL",    city: "Land O Lakes",    state: "FL", zip: ["34638", "34639"] },
  { name: "Wesley Chapel, FL",   city: "Wesley Chapel",   state: "FL", zip: ["33543", "33544", "33545"] },
  { name: "Ocala, FL",           city: "Ocala",           state: "FL", zip: ["34472", "34473", "34476"] },
  { name: "St. Cloud, FL",       city: "St. Cloud",       state: "FL", zip: ["34771", "34772"] },
  { name: "Daytona Beach, FL",   city: "Daytona Beach",   state: "FL", zip: ["32124", "32130"] },
  { name: "Lakeland, FL",        city: "Lakeland",        state: "FL", zip: ["33811", "33812"] },

  // North Carolina
  { name: "Concord, NC",         city: "Concord",         state: "NC", zip: ["28027", "28025"] },
  { name: "Huntersville, NC",    city: "Huntersville",    state: "NC", zip: ["28078"] },
  { name: "Clayton, NC",         city: "Clayton",         state: "NC", zip: ["27527", "27520"] },
  { name: "Apex, NC",            city: "Apex",            state: "NC", zip: ["27539", "27502"] },
  { name: "Knightdale, NC",      city: "Knightdale",      state: "NC", zip: ["27545"] },
  { name: "Fuquay-Varina, NC",   city: "Fuquay-Varina",   state: "NC", zip: ["27526"] },
  { name: "Monroe, NC",          city: "Monroe",          state: "NC", zip: ["28110", "28112"] },

  // Tennessee
  { name: "Murfreesboro, TN",    city: "Murfreesboro",    state: "TN", zip: ["37128", "37129", "37130"] },
  { name: "Nolensville, TN",     city: "Nolensville",     state: "TN", zip: ["37135"] },
  { name: "Franklin, TN",        city: "Franklin",        state: "TN", zip: ["37064", "37067"] },
  { name: "La Vergne, TN",       city: "La Vergne",       state: "TN", zip: ["37086"] },
  { name: "Smyrna, TN",          city: "Smyrna",          state: "TN", zip: ["37167"] },
  { name: "Hendersonville, TN",  city: "Hendersonville",  state: "TN", zip: ["37075"] },

  // Arizona
  { name: "Buckeye, AZ",         city: "Buckeye",         state: "AZ", zip: ["85326", "85396"] },
  { name: "Queen Creek, AZ",     city: "Queen Creek",     state: "AZ", zip: ["85142", "85144"] },
  { name: "Maricopa, AZ",        city: "Maricopa",        state: "AZ", zip: ["85138", "85139"] },
  { name: "Surprise, AZ",        city: "Surprise",        state: "AZ", zip: ["85374", "85379", "85387"] },
  { name: "San Tan Valley, AZ",  city: "San Tan Valley",  state: "AZ", zip: ["85140", "85143"] },

  // Idaho
  { name: "Nampa, ID",           city: "Nampa",           state: "ID", zip: ["83651", "83687"] },
  { name: "Meridian, ID",        city: "Meridian",        state: "ID", zip: ["83642", "83646"] },
  { name: "Eagle, ID",           city: "Eagle",           state: "ID", zip: ["83616"] },
  { name: "Star, ID",            city: "Star",            state: "ID", zip: ["83669"] },

  // South Carolina
  { name: "Simpsonville, SC",    city: "Simpsonville",    state: "SC", zip: ["29680", "29681"] },
  { name: "Boiling Springs, SC", city: "Boiling Springs", state: "SC", zip: ["29316"] },
  { name: "Mauldin, SC",         city: "Mauldin",         state: "SC", zip: ["29662"] },
  { name: "Bluffton, SC",        city: "Bluffton",        state: "SC", zip: ["29909", "29910"] },

  // Alabama
  { name: "Huntsville, AL",      city: "Huntsville",      state: "AL", zip: ["35803", "35811", "35824"] },
  { name: "Madison, AL",         city: "Madison",         state: "AL", zip: ["35757", "35758"] },
  { name: "Athens, AL",          city: "Athens",          state: "AL", zip: ["35611", "35613"] },

  // Colorado
  { name: "Parker, CO",          city: "Parker",          state: "CO", zip: ["80134", "80138"] },
  { name: "Castle Rock, CO",     city: "Castle Rock",     state: "CO", zip: ["80104", "80108"] },
  { name: "Erie, CO",            city: "Erie",            state: "CO", zip: ["80516"] },

  // Nevada
  { name: "Henderson, NV",       city: "Henderson",       state: "NV", zip: ["89002", "89014", "89052"] },
  { name: "North Las Vegas, NV", city: "North Las Vegas", state: "NV", zip: ["89084", "89086", "89081"] },

  // Georgia
  { name: "Cumming, GA",         city: "Cumming",         state: "GA", zip: ["30028", "30040", "30041"] },
  { name: "Gainesville, GA",     city: "Gainesville",     state: "GA", zip: ["30501", "30506", "30507"] },
  { name: "Acworth, GA",         city: "Acworth",         state: "GA", zip: ["30101", "30102"] },
];

function dedup(leads) {
  const seen = new Set();
  return leads.filter(l => {
    const key = (l.phone || l.address || "").replace(/\D/g, "").slice(-10);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── 1. Google Maps — find active new construction areas ───────────────────────
// Searches for major builders in the market, extracts zip codes they're building in
async function findNewConstructionZips(market) {
  await initPuppeteer();
  const extraZips = new Set();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

    // Search Google Maps for new home builders in this market
    const builders = ["DR Horton", "Lennar", "Pulte", "KB Home", "Taylor Morrison"];
    const builder = builders[Math.floor(Math.random() * builders.length)];
    const query = encodeURIComponent(`${builder} new homes ${market.city} ${market.state}`);
    await page.goto(`https://www.google.com/maps/search/${query}`, { waitUntil: "networkidle2", timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000));

    const content = await page.content();
    // Extract zip codes from page content
    const zipMatches = content.match(/\b\d{5}\b/g) || [];
    for (const zip of zipMatches) {
      // Only include zips that plausibly belong to this state
      extraZips.add(zip);
    }

    console.log(`  🗺️  Google Maps: found ${extraZips.size} zip codes near ${builder} in ${market.name}`);
  } catch (err) {
    console.log(`  ⚠️  Google Maps scrape (${market.name}): ${err.message.slice(0, 50)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return [...extraZips].slice(0, 5);
}

// ── 2. BatchData — find vacant lots by zip code ───────────────────────────────
async function findVacantLotsByZip(zipCode, market, maxLeads = 15) {
  if (!BATCH_API_KEY) return [];
  const leads = [];

  try {
    const res = await axios.post(
      "https://api.batchdata.com/api/v1/property/search",
      {
        data: {
          filters: {
            zip: zipCode,
            propertyType: ["Vacant Land", "Agricultural", "Lot"],
            maxValue: 300000,
            absenteeOwner: true,   // Owner doesn't live there = more motivated
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
    for (const p of results) {
      const address = [p.propertyAddress, p.propertyCity, p.propertyState].filter(Boolean).join(", ") || p.address || "";
      if (!address) continue;
      leads.push({
        source: "batchdata_new_construction_adjacent",
        motivation: "absentee_owner_near_construction",
        city: market.name,
        zip: zipCode,
        address,
        askingPrice: p.estimatedValue || p.avm || p.assessedValue || 0,
        acreage: p.lotSizeAcres || p.acreage || null,
        ownerName: [p.ownerFirstName, p.ownerLastName].filter(Boolean).join(" ") || null,
        yearsOwned: p.yearsOwned || null,
        phone: null,
        email: p.ownerEmail || null,
        nearConstruction: true,
        scrapedAt: new Date().toISOString(),
      });
    }

    if (leads.length) console.log(`  ✓ BatchData zip ${zipCode} (${market.name}): ${leads.length} vacant lots`);
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 401) {
      console.log(`  ⚠️  BatchData: property search not enabled on your plan`);
    } else {
      console.log(`  ⚠️  BatchData zip ${zipCode}: ${(err.response?.data?.message || err.message)?.slice(0, 60)}`);
    }
  }
  return leads;
}

// ── 3. Zillow — vacant lots in specific zip code (fallback when BatchData unavailable) ──
async function findZillowLotsInZip(zipCode, market, maxLeads = 12) {
  const leads = [];
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

    const url = `https://www.zillow.com/homes/for_sale/${zipCode}_rb/lot-land_lt/`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const content = await page.content();
    const listings = extractZillowListings(content);
    for (const r of listings.slice(0, maxLeads)) {
      const street = r.address?.streetAddress || r.address || r.streetAddress || "";
      const city   = r.address?.city  || market.city;
      const state  = r.address?.state || market.state;
      if (street) {
        leads.push({
          source: "zillow_lot_near_construction",
          motivation: "near_new_construction",
          city: market.name,
          zip: zipCode,
          address: `${street}, ${city}, ${state}`,
          askingPrice: r.price || r.unformattedPrice || 0,
          acreage: null,
          phone: null,
          nearConstruction: true,
          scrapedAt: new Date().toISOString(),
        });
      }
    }

    if (leads.length) console.log(`  ✓ Zillow lots zip ${zipCode} (${market.name}): ${leads.length} lots`);
  } catch (err) {
    console.log(`  ⚠️  Zillow zip ${zipCode}: ${err.message.slice(0, 50)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return leads.slice(0, maxLeads);
}

// ── 4. Zillow city lot search (proven working fallback) ───────────────────────
async function findZillowLotsByCity(market, maxLeads = 15) {
  const leads = [];
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

    const citySlug = market.city.toLowerCase().replace(/\s+/g, "-");
    const stateSlug = market.state.toLowerCase();
    const url = `https://www.zillow.com/${citySlug}-${stateSlug}/lot-land/`;

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const content = await page.content();
    const listings = extractZillowListings(content);
    for (const r of listings.slice(0, maxLeads)) {
      const street = r.address?.streetAddress || r.address || r.streetAddress || "";
      const city   = r.address?.city  || market.city;
      const state  = r.address?.state || market.state;
      if (street) {
        leads.push({
          source: "zillow_lot_near_construction",
          motivation: "near_new_construction",
          city: market.name,
          address: `${street}, ${city}, ${state}`,
          askingPrice: r.price || r.unformattedPrice || 0,
          acreage: null,
          phone: null,
          nearConstruction: true,
          scrapedAt: new Date().toISOString(),
        });
      }
    }

    if (leads.length) console.log(`  ✓ Zillow lots ${market.name}: ${leads.length} lots`);
  } catch (err) {
    console.log(`  ⚠️  Zillow ${market.name}: ${err.message.slice(0, 50)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return leads.slice(0, maxLeads);
}

// ── 5. BatchData — long-time absentee owners (most motivated) ─────────────────
async function findLongTimeOwners(market, maxLeads = 20) {
  if (!BATCH_API_KEY) return [];
  const leads = [];

  try {
    const res = await axios.post(
      "https://api.batchdata.com/api/v1/property/search",
      {
        data: {
          filters: {
            state: market.state,
            city: market.city,
            propertyType: ["Vacant Land", "Agricultural", "Lot"],
            maxValue: 300000,
            absenteeOwner: true,
            yearsOwned: { min: 8 },  // Owned 8+ years = forgot they have it
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
    for (const p of results) {
      const address = [p.propertyAddress, p.propertyCity, p.propertyState].filter(Boolean).join(", ") || "";
      if (!address) continue;
      leads.push({
        source: "batchdata_long_time_owner",
        motivation: "long_time_absentee_owner",
        city: market.name,
        address,
        askingPrice: p.estimatedValue || p.avm || p.assessedValue || 0,
        acreage: p.lotSizeAcres || p.acreage || null,
        ownerName: [p.ownerFirstName, p.ownerLastName].filter(Boolean).join(" ") || null,
        yearsOwned: p.yearsOwned || null,
        phone: null,
        email: p.ownerEmail || null,
        nearConstruction: false,
        scrapedAt: new Date().toISOString(),
      });
    }

    if (leads.length) console.log(`  ✓ BatchData long-time owners (${market.name}): ${leads.length} lots`);
  } catch (err) {
    const status = err.response?.status;
    if (status !== 403 && status !== 401) {
      console.log(`  ⚠️  BatchData long-time owners (${market.name}): ${err.message?.slice(0, 60)}`);
    }
  }
  return leads;
}

// ── 4. CSV Import (always included) ──────────────────────────────────────────
export function loadManualLeads(maxLeads = 100) {
  const csvPath = "leads_import.csv";
  if (!fs.existsSync(csvPath)) return [];
  const lines = fs.readFileSync(csvPath, "utf8").split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].toLowerCase().split(",").map(h => h.trim().replace(/['"]/g, ""));
  const leads = [];

  for (const line of lines.slice(1, maxLeads + 1)) {
    const fields = [];
    let cur = "", inQ = false;
    for (const c of line) {
      if (c === '"') { inQ = !inQ; }
      else if (c === "," && !inQ) { fields.push(cur); cur = ""; }
      else cur += c;
    }
    fields.push(cur);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (fields[i] || "").trim().replace(/['"]/g, ""));
    const address = obj["address"] || obj["property address"] || obj["situs address"] || "";
    const phone = obj["phone"] || obj["phone number"] || obj["mobile"] || obj["cell"] || "";
    const price = parseInt((obj["price"] || obj["asking price"] || obj["assessed value"] || "0").replace(/[^0-9]/g, "")) || 0;
    if (address) {
      leads.push({
        source: "csv_import",
        city: obj["city"] || obj["county"] || "",
        address,
        askingPrice: price,
        acreage: parseFloat(obj["acreage"] || obj["acres"] || "0") || null,
        phone: phone.replace(/[^0-9]/g, "") || null,
        email: obj["email"] || null,
        ownerName: obj["owner"] || obj["name"] || null,
        motivation: "csv",
        nearConstruction: false,
        scrapedAt: new Date().toISOString(),
      });
    }
  }
  if (leads.length) console.log(`  📄 CSV import: ${leads.length} leads`);
  return leads;
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function findLeads(maxTotal = 30) {
  console.log(`\n🏗️  Finding vacant lots near new construction...`);
  console.log(`   Markets: TX, FL, NC, TN (high-growth builder corridors)\n`);

  const allLeads = [];

  // Always include manual CSV leads
  allLeads.push(...loadManualLeads(50));

  // Pick 2 random markets for this run
  const shuffled = [...MARKETS].sort(() => Math.random() - 0.5);
  const markets = shuffled.slice(0, 2);

  for (const market of markets) {
    console.log(`\n📍 ${market.name}`);

    // Step 1: Find new construction zip codes via Google Maps
    const extraZips = await findNewConstructionZips(market);

    // Combine hardcoded hot zips + dynamically found zips
    const allZips = [...new Set([...market.zip, ...extraZips])].slice(0, 6);
    console.log(`  🏘️  Targeting ${allZips.length} zip codes: ${allZips.join(", ")}`);

    // Step 2: Find vacant lots in construction zip codes
    // Try BatchData first, fall back to Zillow
    let batchWorked = false;
    for (const zip of allZips.slice(0, 3)) {
      const zipLeads = await findVacantLotsByZip(zip, market, 10);
      if (zipLeads.length > 0) batchWorked = true;
      allLeads.push(...zipLeads);
      await new Promise(r => setTimeout(r, 500));
    }

    // Zillow fallback — search by city name (proven to work)
    if (!batchWorked) {
      console.log(`  📋 BatchData unavailable — using Zillow city search`);
      const zillowLeads = await findZillowLotsByCity(market, 15);
      allLeads.push(...zillowLeads);
    }

    // Step 3: BatchData — long-time absentee owners in this market
    const longTimeLeads = await findLongTimeOwners(market, 15);
    allLeads.push(...longTimeLeads);

    // Step 4: County public records — vacant land + 10yr+ absentee owners (free PropStream)
    try {
      const countyLeads = await findCountyRecordLeads([market], 40);
      if (countyLeads.length > 0) {
        console.log(`  🏛️  County records (${market.name}): ${countyLeads.length} long-time owners`);
        allLeads.push(...countyLeads);
      }
    } catch (err) {
      console.log(`  ⚠️  County records (${market.name}): ${err.message?.slice(0, 60)}`);
    }
  }

  // Always pull county records from ALL configured counties (free, 16K+ leads, paginated)
  try {
    const countyLeads = await findCountyRecordLeads([], 60);
    if (countyLeads.length > 0) {
      console.log(`  🏛️  County records (all counties): ${countyLeads.length} leads`);
      allLeads.push(...countyLeads);
    }
  } catch (err) {
    console.log(`  ⚠️  County records sweep: ${err.message?.slice(0, 60)}`);
  }

  console.log(`\n📊 Raw leads collected: ${allLeads.length}`);

  const unique = dedup(allLeads);
  console.log(`   After dedup: ${unique.length}`);

  // Skip trace for phone numbers
  const withPhones = await skipTraceLeads(unique);
  console.log(`   After skip trace: ${withPhones.length} with phone numbers`);

  // Prioritize: near-construction lots first, then long-time owners
  withPhones.sort((a, b) => {
    if (a.nearConstruction && !b.nearConstruction) return -1;
    if (!a.nearConstruction && b.nearConstruction) return 1;
    return (b.yearsOwned || 0) - (a.yearsOwned || 0); // longer ownership = more motivated
  });

  return withPhones.slice(0, maxTotal);
}
