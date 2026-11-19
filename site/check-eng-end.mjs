// The end of the Engineering page, and what paints its background there.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:4500/engineering/");
await page.waitForTimeout(1500);
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await page.waitForTimeout(1200);
await page.screenshot({ path: "lab/eng-end.png" });
console.log(JSON.stringify(await page.evaluate(() => ({
  html: getComputedStyle(document.documentElement).backgroundColor,
  body: getComputedStyle(document.body).backgroundColor,
  slos: getComputedStyle(document.querySelector(".chapter--slos")).backgroundImage.slice(0, 80) + " | " + getComputedStyle(document.querySelector(".chapter--slos")).backgroundColor,
  colophon: getComputedStyle(document.querySelector(".chapter--colophon")).backgroundColor,
  bodyStyle: document.body.getAttribute("style"),
}))));
await browser.close();
