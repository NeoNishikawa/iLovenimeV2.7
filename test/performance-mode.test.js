const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let performanceMode;
test.before(async () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/js/performance-mode.js"), "utf8");
  performanceMode = await import(`data:text/javascript,${encodeURIComponent(source)}`);
});

function setup(mode = null, hardwareConcurrency = 8, deviceMemory = 8) {
  const map = new Map(mode ? [[performanceMode.PERFORMANCE_MODE_KEY, mode]] : []);
  const storage = { getItem: (key) => map.get(key) || null, setItem: (key, value) => map.set(key, String(value)) };
  const root = { dataset: {} };
  const documentRef = { documentElement: root, defaultView: { matchMedia: () => ({ matches: false }) }, dispatchEvent() {} };
  const controller = performanceMode.createPerformanceController({ storage, documentRef, navigatorRef: { hardwareConcurrency, deviceMemory } });
  return { controller, map, root };
}

test("Auto memilih seimbang untuk perangkat terbatas dan penuh untuk desktop mampu", () => {
  assert.equal(performanceMode.initialPerformanceTier("auto", { hardwareConcurrency: 4, deviceMemory: 8 }), "balanced");
  assert.equal(performanceMode.initialPerformanceTier("auto", { hardwareConcurrency: 8, deviceMemory: 8 }), "full");
  assert.equal(performanceMode.initialPerformanceTier("auto", { hardwareConcurrency: 8, deviceMemory: 8, reducedMotion: true }), "low");
  assert.deepEqual(performanceMode.performanceConfig("balanced", false), { tier: "balanced", targetFps: 30, particleCount: 140 });
});

test("mode manual tersimpan dan dipublikasikan ke data attributes", () => {
  const { controller, map, root } = setup();
  assert.equal(controller.getMode(), "auto");
  assert.equal(controller.setMode("low"), true);
  assert.equal(map.get(performanceMode.PERFORMANCE_MODE_KEY), "low");
  assert.equal(root.dataset.performanceMode, "low");
  assert.equal(root.dataset.performanceTier, "low");
  assert.equal(controller.setMode("invalid"), false);
});

test("Auto menurunkan tier setelah FPS/frame-time lambat berkelanjutan", () => {
  const { controller } = setup();
  for (let i = 0; i < 60; i += 1) controller.reportFrame(30);
  assert.equal(controller.getTier(), "balanced");
  for (let i = 0; i < 60; i += 1) controller.reportFrame(36);
  assert.equal(controller.getTier(), "low");
});

test("Auto menaikkan kembali Balanced setelah interval frame stabil", () => {
  const { controller } = setup();
  controller.setMode("balanced");
  controller.setMode("auto");
  assert.equal(controller.getTier(), "full");
  // Feed one slow window to step down, then a stable window to recover.
  for (let i = 0; i < 60; i += 1) controller.reportFrame(30);
  assert.equal(controller.getTier(), "balanced");
  for (let i = 0; i < 60; i += 1) controller.reportFrame(16);
  assert.equal(controller.getTier(), "full");
});
