// Opens the site's pit-wall tab in headless Chrome and photographs it while the recording plays.
// Usage (site/dist served on :4500): node check-pitwall.mjs   CHROME=<path> to pick a browser.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://localhost:4500/pitwall/");
await page.waitForTimeout(6000);
await page.screenshot({ path: "lab/pitwall-1.png" });
await page.getByRole("button", { name: "20×" }).click();
await page.locator('input[aria-label="Jump to lap"]').fill("44");
await page.waitForTimeout(6000);
await page.screenshot({ path: "lab/pitwall-2.png" });
console.log(JSON.stringify({ lap: await page.locator(".lap-count .mono").first().textContent(), errors }));
await browser.close();
