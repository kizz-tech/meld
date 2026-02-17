#!/usr/bin/env node
/**
 * Presskit screenshot generator — headless Playwright.
 * Usage: node scripts/screenshots.mjs [--base-url http://localhost:3000]
 */

import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { resolve } from "path";

const BASE = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ?? "http://localhost:3000";

// ── Output dirs ──────────────────────────────────────────────────────────────
const REPO_ARTIFACTS = resolve(import.meta.dirname, "../artifacts");
const VAULT_SCREENSHOTS = resolve(
  import.meta.dirname,
  "../../../../Documents/kizz/content/meld/assets/screenshots",
);

for (const d of [
  REPO_ARTIFACTS,
  `${VAULT_SCREENSHOTS}/standard`,
  `${VAULT_SCREENSHOTS}/marketing-2560x1600`,
  `${VAULT_SCREENSHOTS}/hero-variants`,
]) {
  mkdirSync(d, { recursive: true });
}

// ── Scene matrix ─────────────────────────────────────────────────────────────
const SCENES = [
  { name: "hero-landing",   url: "/presskit?scene=hero",                   hasTimeline: true },
  { name: "hero-platform",  url: "/presskit?scene=hero&hero=platform",     hasTimeline: true },
  { name: "hero-cinematic", url: "/presskit?scene=hero&hero=cinematic",    hasTimeline: true },
  { name: "chat",           url: "/presskit?scene=chat",                   hasTimeline: true },
  { name: "note",           url: "/presskit?scene=note",                   hasTimeline: true },
  { name: "workflow",       url: "/presskit?scene=workflow",               hasTimeline: true },
];

// ── Viewport presets ─────────────────────────────────────────────────────────
const VIEWPORTS = {
  standard:  { width: 1920, height: 1080 },
  marketing: { width: 2560, height: 1600 },
  social:    { width: 1280, height: 640 },
};

async function expandTimelines(page) {
  // TimelineDisplay is a <section role="button"> with a chevron SVG.
  // Clicking it toggles the expanded state showing individual timeline rows.
  await page.evaluate(() => {
    const sections = document.querySelectorAll('section[role="button"]');
    for (const sec of sections) {
      // Only click if it has the chevron SVG (timeline toggle)
      if (sec.querySelector("svg")) {
        sec.click();
      }
    }
  });
  // Give React a moment to re-render expanded rows
  await page.waitForTimeout(500);
}

async function hideDevOverlay(page) {
  // Hide any Next.js dev overlay elements that might persist
  await page.evaluate(() => {
    const portal = document.querySelector("nextjs-portal");
    if (portal) portal.style.display = "none";
    // Also hide any shadow-DOM dev indicators
    const indicators = document.querySelectorAll("[data-nextjs-dev-overlay]");
    indicators.forEach((el) => (el.style.display = "none"));
  });
}

async function takeScreenshot(page, scene, viewport, outputPath) {
  await page.setViewportSize(viewport);
  await page.goto(`${BASE}${scene.url}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800); // let animations settle

  await hideDevOverlay(page);

  if (scene.hasTimeline) {
    await expandTimelines(page);
  }

  await page.screenshot({ path: outputPath, type: "png", fullPage: false });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    deviceScaleFactor: 2, // Retina-quality
    colorScheme: "dark",
  });
  const page = await context.newPage();

  console.log(`\n  Taking screenshots from ${BASE}/presskit\n`);

  // ── Standard screenshots (1920x1080) ────────────────────────────────────
  for (const scene of SCENES) {
    const outPath = `${VAULT_SCREENSHOTS}/standard/${scene.name}.png`;
    process.stdout.write(`  [standard]  ${scene.name} ...`);
    await takeScreenshot(page, scene, VIEWPORTS.standard, outPath);
    console.log(" done");
  }

  // ── Marketing screenshots (2560x1600) ───────────────────────────────────
  for (const scene of SCENES) {
    const outPath = `${VAULT_SCREENSHOTS}/marketing-2560x1600/${scene.name}.png`;
    process.stdout.write(`  [marketing] ${scene.name} ...`);
    await takeScreenshot(page, scene, VIEWPORTS.marketing, outPath);
    console.log(" done");
  }

  // ── Hero variants for vault ─────────────────────────────────────────────
  for (const scene of SCENES.filter((s) => s.name.startsWith("hero-"))) {
    const outPath = `${VAULT_SCREENSHOTS}/hero-variants/${scene.name}.png`;
    process.stdout.write(`  [hero-var]  ${scene.name} ...`);
    await takeScreenshot(page, scene, VIEWPORTS.standard, outPath);
    console.log(" done");
  }

  // ── Social preview (1280x640, 1x scale for <1MB) ─────────────────────────
  process.stdout.write("  [social]    social-preview ...");
  const socialContext = await browser.newContext({
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  const socialPage = await socialContext.newPage();
  await socialPage.setViewportSize(VIEWPORTS.social);
  const socialScene = SCENES.find((s) => s.name === "hero-cinematic");
  await socialPage.goto(`${BASE}${socialScene.url}`, { waitUntil: "networkidle" });
  await socialPage.waitForTimeout(800);
  await hideDevOverlay(socialPage);
  if (socialScene.hasTimeline) await expandTimelines(socialPage);
  await socialPage.screenshot({
    path: `${VAULT_SCREENSHOTS}/social-preview.png`,
    type: "png",
    fullPage: false,
  });
  await socialPage.close();
  await socialContext.close();
  console.log(" done");

  // ── Copy key assets to repo artifacts ───────────────────────────────────
  // hero.png = note scene (user's favorite) at standard size
  const { copyFileSync } = await import("fs");
  copyFileSync(
    `${VAULT_SCREENSHOTS}/standard/note.png`,
    `${REPO_ARTIFACTS}/hero.png`,
  );
  console.log("\n  Copied note.png → artifacts/hero.png (repo hero)");

  await browser.close();

  console.log(`\n  All screenshots saved.`);
  console.log(`    Vault:     ${VAULT_SCREENSHOTS}/`);
  console.log(`    Repo:      ${REPO_ARTIFACTS}/\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
