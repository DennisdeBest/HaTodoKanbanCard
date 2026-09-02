/*
 * Capture the README images from the demo page, using the system Chrome.
 *
 *   npm run shots
 *
 * The point of shooting the demo rather than a real dashboard is that the demo is
 * deterministic: the same lists, the same wording, no house data, and it runs the real
 * card so the pictures cannot drift from what the code does. Re-run it after any visual
 * change and commit whatever moved.
 *
 * Needs Chrome (or Chromium) and, for the animation, ffmpeg. Set CHROME=/path/to/chrome
 * if it is somewhere unusual.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = join(ROOT, "docs");
const FRAMES = join(ROOT, ".frames");
const PORT = 8129;
const BASE = `http://localhost:${PORT}/demo/index.html`;

const CHROME = process.env.CHROME || [
  "/usr/bin/google-chrome", "/bin/google-chrome",
  "/usr/bin/chromium", "/snap/bin/chromium", "/usr/bin/chromium-browser",
].find((p) => existsSync(p));

if (!CHROME) {
  console.error("No Chrome found. Set CHROME=/path/to/chrome");
  process.exit(1);
}

const SHOTS = [
  { file: "shopping.png",     only: "shopping", theme: "light", width: 1180 },
  { file: "shopping-dark.png", only: "shopping", theme: "dark",  width: 1180 },
  { file: "project-board.png", only: "board",    theme: "light", width: 1180 },
  { file: "chores.png",        only: "chores",   theme: "light", width: 1180 },
  { file: "mobile.png",        only: "shopping", theme: "light", width: 420 },
  { file: "editor.png",        only: "shopping", theme: "light", width: 1180, editor: true },
  { file: "tags.png",          only: "shopping", theme: "light", width: 1180, tags: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  const child = spawn(process.execPath, [join(ROOT, "demo", "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  return child;
}

// The board is the only thing worth photographing, so shoot the element, not the page.
async function shootCard(page, path) {
  const card = await page.$("todo-kanban-card");
  await card.screenshot({ path });
  console.log("  ", path.replace(ROOT, ""));
}

// The tag suggestions, mid-type: the row narrowed to what matches "#s".
async function openTagPicker(page) {
  await page.evaluate(() => {
    const card = document.querySelector("todo-kanban-card");
    const lane = card.shadowRoot.querySelectorAll(".lane")[1];
    const field = lane.querySelector(".add .field");
    field.focus();
    field.value = "Cumin #s";
    field.setSelectionRange(field.value.length, field.value.length);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
}

async function openEditor(page) {
  await page.evaluate(() => {
    const card = document.querySelector("todo-kanban-card");
    const lane = card.shadowRoot.querySelectorAll(".lane")[1];
    lane.querySelectorAll(".items > [data-uid] .label")[2].click();
  });
  await sleep(150);
}

async function stills(browser) {
  for (const shot of SHOTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: shot.width, height: 900, deviceScaleFactor: 2 });
    await page.goto(`${BASE}?only=${shot.only}&bare&theme=${shot.theme}`, { waitUntil: "networkidle0" });
    await sleep(250);
    if (shot.editor) await openEditor(page);
    if (shot.tags) await openTagPicker(page);
    await shootCard(page, join(DOCS, shot.file));
    await page.close();
  }
}

/*
 * The drag animation. Everything else on the board is a still; this is the one thing
 * that needs to move to be understood, so it is worth the frames.
 */
async function dragAnimation(browser) {
  await rm(FRAMES, { recursive: true, force: true });
  await mkdir(FRAMES, { recursive: true });

  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 560, deviceScaleFactor: 1 });
  await page.goto(`${BASE}?only=shopping&bare&theme=light`, { waitUntil: "networkidle0" });
  await sleep(300);

  const box = await page.evaluate(() => {
    const card = document.querySelector("todo-kanban-card");
    const lanes = card.shadowRoot.querySelectorAll(".lane");
    const row = lanes[1].querySelectorAll(".items > [data-uid]")[1];  // "Smoked paprika"
    const grip = row.querySelector(".grip").getBoundingClientRect();
    const target = lanes[0].querySelector(".items").getBoundingClientRect();
    const card_ = card.getBoundingClientRect();
    return {
      from: { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
      to: { x: target.x + target.width / 2, y: target.y + 12 },
      clip: { x: card_.x, y: card_.y, width: card_.width, height: card_.height },
    };
  });

  let n = 0;
  const frame = async (hold = 1) => {
    for (let i = 0; i < hold; i++) {
      await page.screenshot({
        path: join(FRAMES, String(n++).padStart(3, "0") + ".png"),
        clip: box.clip,
      });
    }
  };

  await frame(6);                                  // rest, so the start is readable
  await page.mouse.move(box.from.x, box.from.y);
  await frame(2);
  await page.mouse.down();
  await frame(2);

  const STEPS = 26;
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(
      box.from.x + (box.to.x - box.from.x) * ease,
      box.from.y + (box.to.y - box.from.y) * ease
    );
    await frame();
  }
  await frame(3);
  await page.mouse.up();
  await sleep(220);
  await frame(10);                                 // and rest on the result
  await page.close();

  const count = (await readdir(FRAMES)).length;
  console.log(`   ${count} frames -> docs/drag.gif`);
  await new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y", "-loglevel", "error", "-framerate", "14",
      "-i", join(FRAMES, "%03d.png"),
      "-vf", "fps=14,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer",
      "-loop", "0", join(DOCS, "drag.gif"),
    ], { stdio: "inherit" });
    ff.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`))));
    ff.on("error", reject);
  });
  await rm(FRAMES, { recursive: true, force: true });
}

const server = serve();
let browser;
try {
  await sleep(600);
  await mkdir(DOCS, { recursive: true });
  browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--force-color-profile=srgb", "--hide-scrollbars"],
  });
  console.log("stills:");
  await stills(browser);
  console.log("animation:");
  await dragAnimation(browser);
  console.log("done");
} finally {
  if (browser) await browser.close();
  server.kill();
}
