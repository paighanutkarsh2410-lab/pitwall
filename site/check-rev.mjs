// Photographs the hero several times while the car revs (no scrolling), to judge the motion.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:4500/?race=2024-sao-paulo");
await page.waitForTimeout(3500);
for (let i = 0; i < 4; i++) {
  await page.screenshot({ path: `lab/rev-${i}.png` });
  await page.waitForTimeout(170);
}
await browser.close();
