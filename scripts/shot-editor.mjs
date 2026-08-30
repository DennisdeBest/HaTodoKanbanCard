/*
 * Screenshot the visual editor, against a real Home Assistant.
 *
 *   HA_URL=http://homeassistant:8123 HA_TOKEN=... npm run shots:editor
 *
 * The rest of the images come from the demo page, which is deterministic and needs no
 * Home Assistant. The editor cannot: it is built out of `ha-form`, `ha-entity-picker`,
 * `ha-icon-picker` and `ha-color-picker`, which only exist inside a dashboard. Faking
 * them would produce a picture of something that does not exist.
 *
 * **It photographs the version installed on that instance, not your working tree.** The
 * page loads the card from HACS like any dashboard would, so run your deploy step first
 * or you will screenshot the last release and wonder where your new section went.
 *
 * So this loads a real dashboard (which is what defines those elements and gives us a
 * `hass` object), then builds the editor element and photographs it. Nothing is opened
 * in edit mode and nothing is saved — the instance is only ever read from.
 *
 * **The editor has to be mounted inside `<home-assistant>`**, specifically in its shadow
 * root. `ha-entity-picker` reads its translations from a lit *context*, which resolves
 * by walking up the DOM to a provider on that element; mounted on `document.body` the
 * picker is a sibling of the provider rather than a descendant, so the context never
 * resolves, it throws on `this._i18n.localize` and renders nothing at all. The colour
 * and icon pickers do not care, which makes the failure look like a bug in the entity
 * field specifically. In a dashboard the editor lives inside a dialog under that same
 * element, so this only ever bites a harness like this one.
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = join(ROOT, "docs");
const HA_URL = (process.env.HA_URL || "http://192.168.1.20:8123").replace(/\/$/, "");
const TOKEN = process.env.HA_TOKEN;
const CHROME = process.env.CHROME || ["/usr/bin/google-chrome", "/bin/google-chrome",
  "/usr/bin/chromium", "/snap/bin/chromium"].find((p) => existsSync(p));

if (!TOKEN) {
  console.error("HA_TOKEN is not set — this one needs a real Home Assistant to shoot.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIG = {
  title: "Shopping",
  enable_tags: true,
  tags: { spices: "orange", fresh: "green", pets: "purple" },
  lanes: [
    { entity: "todo.shopping_urgent", title: "Urgent", icon: "mdi:alert-octagon", color: "red" },
    { entity: "todo.shopping", title: "Normal", icon: "mdi:cart", color: "blue" },
    { entity: "todo.shopping_long_haul", title: "Long haul", icon: "mdi:calendar-clock", color: "purple" },
  ],
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--force-color-profile=srgb", "--hide-scrollbars"],
});

try {
  await mkdir(DOCS, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 3400, deviceScaleFactor: 2 });

  await page.goto(`${HA_URL}/lovelace/0`, { waitUntil: "domcontentloaded" });
  await page.evaluate((token, url) => {
    localStorage.setItem("hassTokens", JSON.stringify({
      access_token: token, token_type: "Bearer", refresh_token: "",
      expires_in: 315360000, hassUrl: url, clientId: null,
      expires: Date.now() + 315360000000,
    }));
  }, TOKEN, HA_URL);

  // A dashboard page is what loads the card's own resource and Home Assistant's form
  // controls. Read-only: we never enter edit mode.
  await page.goto(`${HA_URL}/lovelace/0`, { waitUntil: "networkidle2" });
  await sleep(4000);

  const ready = await page.evaluate(() => ({
    hass: !!document.querySelector("home-assistant")?.hass,
    editor: !!customElements.get("todo-kanban-card-editor"),
    form: !!customElements.get("ha-form"),
  }));
  console.log("  page:", ready);
  if (!ready.hass || !ready.editor) throw new Error("dashboard did not come up as expected");

  // `ha-form` is loaded lazily. Asking for it the way Home Assistant does makes it
  // resolve before we photograph a form that has not upgraded yet.
  if (!ready.form) {
    await page.evaluate(() => customElements.whenDefined("ha-form"));
    await page.evaluate(async () => {
      const card = document.createElement("hui-entities-card");
      document.body.appendChild(card);
      card.remove();
    }).catch(() => {});
  }

  await page.evaluate(async (config) => {
    const ha = document.querySelector("home-assistant");
    const hass = ha.hass;
    const host = document.createElement("div");
    host.id = "shot-host";
    // Absolute and tall enough for the whole form: a fixed, viewport-height overlay
    // clipped the pane and let the dashboard show through underneath it.
    Object.assign(host.style, {
      position: "absolute", top: "0", left: "0", right: "0",
      minHeight: "100%", zIndex: "9999",
      background: "var(--primary-background-color, #f2f4f7)",
      padding: "24px", boxSizing: "border-box",
      display: "flex", justifyContent: "center", alignItems: "flex-start",
    });
    const pane = document.createElement("div");
    pane.id = "shot-pane";
    Object.assign(pane.style, {
      width: "760px", padding: "24px", borderRadius: "16px",
      background: "var(--card-background-color, #fff)",
      boxShadow: "0 2px 12px rgba(0,0,0,.14)", boxSizing: "border-box",
    });
    const editor = document.createElement("todo-kanban-card-editor");
    editor.hass = hass;
    editor.setConfig(config);
    pane.appendChild(editor);
    host.appendChild(pane);
    // Inside the shadow root of <home-assistant>: rendered, and downstream of the
    // context provider the entity picker needs.
    ha.shadowRoot.appendChild(host);
    await customElements.whenDefined("ha-form");
    await new Promise((r) => setTimeout(r, 1200));
  }, CONFIG);

  await sleep(2500);
  // The pane lives in a shadow root, which page.$ does not reach into.
  const pane = (await page.evaluateHandle(() =>
    document.querySelector("home-assistant").shadowRoot.querySelector("#shot-pane")
  )).asElement();
  if (!pane) throw new Error("the editor pane was not mounted");
  await pane.screenshot({ path: join(DOCS, "editor-visual.png") });
  console.log("   docs/editor-visual.png");

  await browser.close();
  console.log("done — nothing on the instance was modified");
} catch (err) {
  await browser.close();
  console.error(err.message);
  process.exit(1);
}
