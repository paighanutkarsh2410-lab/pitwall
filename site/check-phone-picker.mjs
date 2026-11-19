// The picker on a phone: the hero, the open picker, and a pick.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await page.goto("http://localhost:4500/?race=2025-silverstone");
await page.waitForTimeout(5000);
await page.screenshot({ path: "lab/phone-0.png" });
await page.click(".pick");
await page.waitForTimeout(700);
await page.screenshot({ path: "lab/phone-1.png" });
await page.evaluate(() => document.querySelector(".picker__seasons").scrollTo(0, 2400));
await page.waitForTimeout(300);
await page.screenshot({ path: "lab/phone-2.png" });
await page.click('.race[data-race="2026-sao-paulo"]');
await page.waitForTimeout(4500);
await page.screenshot({ path: "lab/phone-3.png" });
await browser.close();
