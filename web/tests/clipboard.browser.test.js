#!/usr/bin/env node
/**
 * Browser integration checks for Copy image (requires playwright-core and Chrome).
 * Start the app with `python3 -m http.server 8767 --directory web`, then run:
 * NODE_PATH=/path/to/node_modules node web/tests/clipboard.browser.test.js [url] [output-dir]
 * Set CHROME_BIN when Chrome is not at /usr/bin/google-chrome.
 */
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

(async () => {
  const out = process.argv[3] || "/tmp/automata-copy-image-checks";
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(process.argv[2] || "http://127.0.0.1:8767/");
    await page.evaluate(() => {
      window.qa = { write: navigator.clipboard.write.bind(navigator.clipboard) };
      const original = GraphView.prototype.toStandaloneSvg;
      GraphView.prototype.toStandaloneSvg = function (...args) {
        qa.graph = this;
        qa.svg = original.apply(this, args);
        return qa.svg;
      };
    });
    const shot = async (name) => {
      await page.waitForTimeout(250); // let toast and layout transitions settle
      await page.screenshot({ path: path.join(out, name + ".png") });
    };
    const copied = () => page.waitForFunction(() => document.querySelector("#toast").textContent === "Image copied.");
    const fallback = () => page.locator("#copy-image-dialog").waitFor({ state: "visible" });
    const stub = (mode) => page.evaluate((mode) => {
      qa.calls = 0;
      navigator.clipboard.write = (items) => {
        qa.calls++;
        qa.item = items[0];
        if (mode === "pending") return new Promise((resolve, reject) => { qa.resolve = resolve; qa.reject = reject; });
        return Promise.reject(new DOMException("Denied", "NotAllowedError"));
      };
    }, mode);

    // Actual PNG write and clipboard readback, not a mocked success.
    await page.click("#btn-copy-image");
    await copied();
    const bytes = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const blob = await items[0].getType("image/png");
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    assert.deepEqual(bytes.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
    await fs.writeFile(path.join(out, "clipboard-readback.png"), Buffer.from(bytes));
    await shot("01-copied");
    console.log("PASS real clipboard PNG write/readback");

    // Busy state, double-click guard, snapshot framing, and clean highlights.
    await page.fill("#input-string", "01");
    await page.click("#btn-simulate");
    await page.click("#btn-step-first");
    await page.click("#btn-step-next");
    await stub("pending");
    const snapshot = await page.evaluate(() => {
      const g = qa.graph;
      g.selectedState = "q0";
      g.deadStates.add("q1"); g.unreachableStates.add("q1");
      g.render();
      g.setHoverEdges("q0", ["q0"]);
      const live = g.svg.outerHTML;
      const legacy = g.toStandaloneSvg("#ffffff");
      qa.expected = g.contentBounds();
      g.scale = 0.5; g.offsetX = 3000; g.offsetY = -2000; g.applyTransform();
      document.querySelector("#toast").textContent = "";
      document.querySelector("#btn-copy-image").click();
      document.querySelector("#btn-copy-image").click();
      const xml = new DOMParser().parseFromString(qa.svg, "image/svg+xml");
      return {
        calls: qa.calls,
        busy: document.querySelector("#btn-copy-image").textContent,
        disabled: document.querySelector("#btn-copy-image").disabled,
        prematureSuccess: document.querySelector("#toast").textContent === "Image copied.",
        selection: xml.querySelectorAll("[data-selection]").length,
        hover: xml.querySelectorAll('[stroke="#8e5ad8"]').length,
        sim: xml.querySelectorAll('[stroke="#e0483e"]').length,
        liveSelection: g.svg.querySelectorAll("[data-selection]").length,
        liveHover: g.svg.querySelectorAll('[stroke="#8e5ad8"]').length,
        transform: xml.querySelector("#viewport").getAttribute("transform"),
        // Selection and hover remain on the actual diagram.
        wasSelected: live.includes("data-selection"),
        diagnostics: xml.querySelectorAll('[fill="#8a8f98"]').length > 0 && xml.querySelectorAll('[stroke-dasharray="6 4"]').length > 0,
        legacySelection: legacy.includes("data-selection"),
        legacyHover: legacy.includes('stroke="#8e5ad8"'),
      };
    });
    assert.equal(snapshot.calls, 1);
    assert.equal(snapshot.busy, "Copying…");
    assert.equal(snapshot.disabled, true);
    assert.equal(snapshot.prematureSuccess, false);
    assert.equal(snapshot.selection, 0);
    assert.equal(snapshot.hover, 0);
    assert.ok(snapshot.sim > 0);
    assert.equal(snapshot.liveSelection, 1);
    assert.ok(snapshot.liveHover > 0);
    assert.equal(snapshot.transform, null);
    assert.equal(snapshot.wasSelected, true);
    assert.equal(snapshot.diagnostics, true);
    assert.equal(snapshot.legacySelection, true);
    assert.equal(snapshot.legacyHover, true);
    await page.evaluate(() => {
      const g = qa.graph;
      const report = analyzeProperties(g.automaton);
      g.deadStates = report.deadStates; g.unreachableStates = report.unreachableStates;
      g.render(); g.fitView();
    });
    await shot("02-copying");
    const image = await page.evaluate(async () => {
      const blob = await qa.item.getType("image/png");
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, expectedWidth: Math.round(qa.expected.width * 2), expectedHeight: Math.round(qa.expected.height * 2), pixel: Array.from(ctx.getImageData(0, 0, 1, 1).data) };
    });
    assert.equal(image.width, image.expectedWidth);
    assert.equal(image.height, image.expectedHeight);
    assert.deepEqual(image.pixel, [255, 255, 255, 255]);
    const cleanBytes = await page.evaluate(async () => Array.from(new Uint8Array(await (await qa.item.getType("image/png")).arrayBuffer())));
    await fs.writeFile(path.join(out, "clean-simulation.png"), Buffer.from(cleanBytes));
    await page.evaluate(() => qa.resolve());
    await copied();
    await page.waitForFunction(() => !document.querySelector("#btn-copy-image").disabled);
    console.log("PASS busy/double-click, clean snapshot, simulation, pan/zoom, 2× light PNG");

    // Permission rejection offers a download of the original captured image,
    // even if the active tab changes before PNG rendering finishes.
    await stub("denied");
    await page.evaluate(() => qa.graph.fitView());
    await page.click("#btn-copy-image");
    await fallback();
    assert.match(await page.textContent("#copy-image-error"), /denied/i);
    await shot("03-permission-fallback");
    const originalPng = await page.evaluate(async () => Array.from(new Uint8Array(await (await qa.item.getType("image/png")).arrayBuffer())));
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#copy-image-download")]);
    const downloaded = await fs.readFile(await download.path());
    assert.deepEqual(downloaded, Buffer.from(originalPng));
    await page.locator("#copy-image-dialog").waitFor({ state: "hidden" });
    console.log("PASS permission rejection and byte-identical PNG download");

    // Unsupported API and unsupported PNG format both explain the fallback.
    await page.evaluate(() => { navigator.clipboard.write = undefined; });
    await page.click("#btn-copy-image"); await fallback();
    assert.match(await page.textContent("#copy-image-error"), /cannot copy images/i);
    await shot("04-unsupported-fallback");
    await page.click("#copy-image-close");
    await page.evaluate(() => { navigator.clipboard.write = qa.write; qa.supports = ClipboardItem.supports; ClipboardItem.supports = () => false; });
    await page.click("#btn-copy-image"); await fallback();
    await page.click("#copy-image-close");
    await page.evaluate(() => { ClipboardItem.supports = qa.supports; });
    console.log("PASS missing API and unsupported PNG fallback");

    // A rejected PNG render is surfaced and never reported as copied.
    await page.evaluate(() => {
      qa.png = GraphView.prototype.toPngBlob;
      GraphView.prototype.toPngBlob = () => Promise.reject(new Error("Render failed"));
      navigator.clipboard.write = (items) => items[0].getType("image/png");
    });
    await page.click("#btn-copy-image");
    await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Render failed"));
    assert.equal(await page.locator("#copy-image-dialog").isVisible(), false);
    await page.evaluate(() => { GraphView.prototype.toPngBlob = qa.png; navigator.clipboard.write = qa.write; });
    console.log("PASS render failure, no false success or unhandled rejection");

    // Dark theme uses an opaque matching background.
    await page.click("#btn-theme");
    await stub("pending");
    await page.click("#btn-copy-image");
    const dark = await page.evaluate(async () => {
      const bmp = await createImageBitmap(await qa.item.getType("image/png"));
      const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext("2d"); ctx.drawImage(bmp, 0, 0);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    });
    // Raster color conversion can round a channel by one level.
    assert.ok(dark.slice(0, 3).every((value, i) => Math.abs(value - [20, 22, 26][i]) <= 1));
    assert.equal(dark[3], 255);
    await page.evaluate(() => qa.resolve()); await copied();
    await shot("05-dark-mode");
    console.log("PASS opaque dark-theme PNG");

    // Empty/new tab remains disabled when an older copy completes.
    await stub("pending"); await page.click("#btn-copy-image");
    await page.click("#btn-new");
    await page.evaluate(() => qa.resolve());
    await page.waitForFunction(() => document.querySelector("#btn-copy-image").getAttribute("aria-busy") === "false");
    assert.equal(await page.isDisabled("#btn-copy-image"), true);
    await shot("06-empty-disabled");
    console.log("PASS empty tab and completion after tab switch");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot("07-mobile");
    console.log("PASS 390px toolbar fits without page overflow");
    assert.deepEqual(errors, []);
    console.log("All clipboard browser checks passed.");
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
