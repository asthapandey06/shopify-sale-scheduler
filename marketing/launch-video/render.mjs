// Renders launch.html frame by frame (deterministic timeline) to JPEGs for ffmpeg.
// Needs playwright-core and a Chromium build: set PLAYWRIGHT_CORE (path to playwright-core/index.mjs) and CHROME.
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
import { mkdirSync } from "node:fs";
const dir = new URL(".", import.meta.url).pathname;
const [fps, seconds, only] = [30, 30, process.argv[2]];
mkdirSync(dir + "frames", { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto("file://" + dir + "launch.html");
await page.evaluate(() => document.fonts.ready);
const fontOk = await page.evaluate(() => document.fonts.check("800 40px Inter"));
console.log("Inter loaded:", fontOk);
const times = only ? only.split(",").map(Number) : Array.from({ length: fps * seconds }, (_, i) => i / fps);
let n = 0;
for (const t of times) {
  await page.evaluate((x) => window.render(x), t);
  const name = only ? `preview-${String(t).replace(".", "_")}` : `f${String(n).padStart(4, "0")}`;
  await page.screenshot({ path: `${dir}${only ? "" : "frames/"}${name}.jpg`, type: "jpeg", quality: 95 });
  n++;
}
await browser.close();
console.log("frames:", n);
