// Photographs the home page in headless Chrome: the hero revving, then the launch and the roll.
// Usage (site/dist served on :4500): node check-home.mjs [width height]   CHROME=<path> to pick a browser.
import { chromium } from "playwright-core";
const [w = 1440, h = 900] = process.argv.slice(2).map(Number);
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--use-angle=default", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://localhost:4500/");
await page.waitForTimeout(3500);
const tag = `${w}x${h}`;
await page.screenshot({ path: `lab/home-${tag}-0.png` });
for (const [i, f] of [[1, 0.35], [2, 0.8], [3, 1.3], [4, 1.8], [5, 2.6]]) {
  await page.evaluate((y) => window.scrollTo(0, y), Math.round(h * f));
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `lab/home-${tag}-${i}.png` });
}
console.log(JSON.stringify({ errors }));
await browser.close();
