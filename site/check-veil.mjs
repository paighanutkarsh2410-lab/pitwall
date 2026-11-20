// Stops on frames of the launch's end (?still: no carry), from the burnout through the smoke to
// the winner's card, on a desktop and a phone, and writes lab/veil-<view>-<progress>.png.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const views = { desk: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const marks = [0.4, 0.52, 0.58, 0.64, 0.7, 0.76, 0.8, 0.84, 0.88, 0.92, 0.96, 1];
const errors = [];
for (const [name, viewport] of Object.entries(views)) {
  const page = await browser.newPage({ viewport, isMobile: name === "phone", hasTouch: name === "phone" });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4500/?race=2024-sao-paulo&still");
  await page.waitForTimeout(4000);
  for (const m of marks) {
    await page.evaluate((y) => window.scrollTo(0, y), m * 3 * viewport.height);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `lab/veil-${name}-${Math.round(m * 100)}.png` });
  }
  await page.close();
}
console.log("errors:", errors.length ? errors : "none");
await browser.close();
