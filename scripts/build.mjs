/*
 * formfillm build script (esbuild)
 *
 * Why esbuild instead of a heavier bundler: this MVP is meant to be
 * audit-friendly. The build does exactly three bundles plus static copies,
 * with no plugins that could inject remote URLs, telemetry, or hidden code.
 *
 * Output layout (dist/ is loaded as an unpacked extension):
 *   dist/manifest.json
 *   dist/background.js      (ES module service worker)
 *   dist/content.js         (IIFE classic script, injected via chrome.scripting)
 *   dist/sidepanel.js       (ES module loaded by sidepanel.html)
 *   dist/sidepanel.html
 *   dist/sidepanel.css
 *   dist/icons/*.png
 */

import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "dist");
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  target: ["chrome120"],
  logLevel: "info",
  // Fail closed on anything that smells like dynamic code execution sneaking in.
  define: { "process.env.NODE_ENV": '"production"' },
};

/** @type {esbuild.BuildOptions[]} */
const builds = [
  {
    ...common,
    entryPoints: { background: resolve(root, "src/background/service-worker.ts") },
    outdir,
    format: "esm",
  },
  {
    ...common,
    // Content script is injected as a classic file via chrome.scripting.executeScript,
    // so it must be a self-contained IIFE with no import/export statements at runtime.
    entryPoints: { content: resolve(root, "src/content/content-entry.ts") },
    outdir,
    format: "iife",
  },
  {
    ...common,
    entryPoints: { sidepanel: resolve(root, "src/sidepanel/sidepanel.ts") },
    outdir,
    format: "esm",
  },
];

async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  await cp(resolve(root, "manifest.json"), resolve(outdir, "manifest.json"));
  await cp(resolve(root, "src/sidepanel/sidepanel.html"), resolve(outdir, "sidepanel.html"));
  await cp(resolve(root, "src/sidepanel/sidepanel.css"), resolve(outdir, "sidepanel.css"));
  if (existsSync(resolve(root, "icons"))) {
    await cp(resolve(root, "icons"), resolve(outdir, "icons"), { recursive: true });
  }
}

async function run() {
  await rm(outdir, { recursive: true, force: true });
  await copyStatic();

  if (watch) {
    const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log("[formfillm] watching for changes (static files: rebuild to copy)…");
  } else {
    await Promise.all(builds.map((b) => esbuild.build(b)));
    console.log("[formfillm] build complete → dist/");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
