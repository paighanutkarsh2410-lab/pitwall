// Photographs every car in models/cars.json: the hero (revving) and mid-roll, side by side.
// Usage (site/dist served on :4500): node check-cars.mjs
import { chromium } from "playwright-core";
import fs from "node:fs";
const { cars } = JSON.parse(fs.readFileSync("dist/models/cars.json", "utf8"));
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
const notes = [];
page.on("console", (m) => notes.push(m.text()));
for (const car of cars) {
  notes.length = 0;
  await page.goto(`http://localhost:4500/?car=${car.id}`);
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `lab/car-${car.id}-0.png` });
  await page.evaluate(() => window.scrollTo(0, innerHeight * 1.3));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `lab/car-${car.id}-1.png` });
  console.log(car.id, notes.filter((n) => /wheels|error|did not load/i.test(n)).join(" | "));
}
await browser.close();
