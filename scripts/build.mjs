/*
 * Build the single file HACS installs, out of the modules in src/.
 *
 * HACS downloads exactly one file — the `filename` named in hacs.json — so a card
 * cannot ship separate modules or a stylesheet: a sibling .css would never be installed
 * and an `import` of one would 404 on every dashboard. The source is split for the sake
 * of anyone reading it; this puts it back together.
 *
 *   npm run build          write todo-kanban-card.js
 *   npm run build -- --check   fail if the committed file is out of date
 *
 * Deliberately not minified. The point of a single-file card is that someone can read
 * what they are about to run.
 */
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "todo-kanban-card.js");

const version = (await readFile(join(ROOT, "src", "version.js"), "utf8"))
  .match(/VERSION\s*=\s*"([^"]+)"/)[1];

const result = await build({
  entryPoints: [join(ROOT, "src", "index.js")],
  bundle: true,
  format: "esm",
  target: "es2022",
  charset: "utf8",
  legalComments: "inline",
  minify: false,
  loader: { ".css": "text" },
  banner: {
    js: `/* todo-kanban-card ${version} — https://github.com/DennisdeBest/HaTodoKanbanCard
 *
 * BUILT FILE — do not edit. The source is in src/; run \`npm run build\`.
 * MIT licensed. Bundled from src/ so that HACS, which installs exactly one file,
 * has one file to install.
 */`,
  },
  write: false,
});

const built = result.outputFiles[0].text;

if (process.argv.includes("--check")) {
  const current = await readFile(OUT, "utf8").catch(() => "");
  if (current !== built) {
    console.error("todo-kanban-card.js is out of date — run `npm run build` and commit it.");
    process.exit(1);
  }
  console.log(`todo-kanban-card.js is up to date (${version})`);
} else {
  await writeFile(OUT, built);
  console.log(`todo-kanban-card.js ${version} — ${(built.length / 1024).toFixed(1)} kB`);
}
