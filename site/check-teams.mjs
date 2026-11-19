// The team wash: pick races won by four teams in turn, photographing mid-wash and on arrival.
import { chromium } from "playwright-core";
const order = process.argv.slice(2).length ? process.argv.slice(2) : ["2025-silverstone", "2026-austin", "2024-mexico-city", "2024-sao-paulo"];
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://localhost:4500/?race=2024-sao-paulo");
await page.waitForTimeout(4500);
await page.screenshot({ path: "lab/team-0.png" });
let i = 1;
for (const race of order) {
  await page.click(".pick");
  await page.waitForTimeout(500);
  await page.click(`.race[data-race="${race}"]`);
  await page.waitForTimeout(520);
  await page.screenshot({ path: `lab/team-${i}-wash.png` });
  await page.waitForTimeout(3600);
  await page.screenshot({ path: `lab/team-${i}.png` });
  i++;
}
await page.evaluate(() => window.scrollTo(0, innerHeight * 2.6));
await page.waitForTimeout(1500);
await page.screenshot({ path: "lab/team-card.png" });
console.log(JSON.stringify({ errors }));
await browser.close();
