// The race picker end to end: open it, pick a race, watch the cars swap, follow the pit-wall link.
// Usage (site/dist served on :4500): node check-picker.mjs <race-id> [<race-with-recording>]
import { chromium } from "playwright-core";
const [pick = "2025-silverstone"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const log = [];
page.on("console", (m) => log.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => log.push(`pageerror: ${e}`));
await page.goto("http://localhost:4500/");
await page.waitForTimeout(4500);
await page.screenshot({ path: "lab/pick-0-home.png" });
await page.click(".pick");
await page.waitForTimeout(600);
await page.screenshot({ path: "lab/pick-1-picker.png" });
await page.click(`.race[data-race="${pick}"]`);
await page.waitForTimeout(900);
await page.screenshot({ path: "lab/pick-2-arriving.png" });
await page.waitForTimeout(3000);
await page.screenshot({ path: "lab/pick-3-arrived.png" });
await page.evaluate(() => window.scrollTo(0, innerHeight * 2.6));
await page.waitForTimeout(1600);
await page.screenshot({ path: "lab/pick-4-card.png" });
const href = await page.getAttribute(".cta", "href");
console.log(JSON.stringify({ url: page.url(), cta: href, title: await page.title() }));
if (href && href.includes("race=")) {
  await page.goto(new URL(href, page.url()).href);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "lab/pick-5-pitwall.png" });
  console.log(JSON.stringify({ pitwall: await page.locator(".race h1").first().textContent(), lap: await page.locator(".lap-count .mono").first().textContent() }));
}
console.log(log.filter((l) => !l.startsWith("info") || l.includes("car:")).join("\n"));
await browser.close();
