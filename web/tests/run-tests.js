#!/usr/bin/env node
/**
 * Test runner for the web app.
 *
 * The browser sources are plain classic scripts that share one global scope
 * and deliberately have no module system, so the runner rebuilds that same
 * environment in a Node vm context and then executes each test file in it.
 *
 * Usage:  node web/tests/run-tests.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const jsDir = path.join(__dirname, "..", "js");
const sources = ["automaton.js", "algorithms.js", "layout.js", "examples.js", "import.js", "documents.js"];
const testFiles = ["algorithms.test.js", "layout.test.js", "import.test.js", "documents.test.js"];

// Each test file gets a fresh context so their top-level names cannot clash.
let failures = 0;
for (const testName of testFiles) {
  const context = vm.createContext({ console: console, JSON: JSON, Math: Math });
  for (const file of sources) {
    const fullPath = path.join(jsDir, file);
    vm.runInContext(fs.readFileSync(fullPath, "utf8"), context, { filename: fullPath });
  }
  const testFile = path.join(__dirname, testName);
  vm.runInContext(fs.readFileSync(testFile, "utf8"), context, { filename: testFile });
  failures += vm.runInContext("globalThis.__TEST_FAILURES__", context);
  console.log("");
}

process.exit(failures === 0 ? 0 : 1);
