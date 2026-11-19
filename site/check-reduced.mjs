// The home page with reduced motion: no pin, no roll; the car holds still and the card follows.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
await page.goto("http://localhost:4500/?race=2024-sao-paulo");
await page.waitForTimeout(3500);
await page.screenshot({ path: "lab/home-reduced-0.png" });
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(1200);
await page.screenshot({ path: "lab/home-reduced-1.png" });
console.log(await page.evaluate(() => ({ height: document.documentElement.scrollHeight, pinned: !!document.querySelector(".pin-spacer") })));
await browser.close();
