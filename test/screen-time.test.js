const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let screenTime;
test.before(async () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/js/screen-time.js"), "utf8");
  screenTime = await import(`data:text/javascript,${encodeURIComponent(source)}`);
});

class EventHub {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn) { const list = this.listeners.get(name) || []; list.push(fn); this.listeners.set(name, list); }
  removeEventListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) || []).filter((listener) => listener !== fn)); }
  dispatch(name) { for (const listener of this.listeners.get(name) || []) listener({ type: name }); }
}
class MemoryStorage {
  constructor(initial = null) { this.data = new Map(initial ? [[screenTime?.SCREEN_TIME_KEY || "iln:screen-time", initial]] : []); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
}
function harness(initialState = null, trackerOptions = {}) {
  let perf = 0;
  let wall = 20_000 * 86_400_000 + 12 * 3_600_000;
  const doc = new EventHub();
  doc.visibilityState = "visible";
  doc.hasFocus = () => focused;
  const win = new EventHub();
  const storage = new MemoryStorage(initialState);
  const reminders = [];
  let focused = true;
  let scheduled = null;
  const clock = { performanceNow: () => perf, wallNow: () => wall };
  const scheduler = { setInterval: (fn) => { scheduled = fn; return 1; }, clearInterval: () => { scheduled = null; } };
  const tracker = screenTime.createScreenTimeTracker({
    storage,
    clock,
    documentRef: doc,
    windowRef: win,
    scheduler,
    dateKey: (epoch) => `day-${Math.floor(epoch / 86_400_000)}`,
    onReminder: (reminder) => reminders.push(reminder),
    testMode: trackerOptions.testMode ?? screenTime.SCREEN_TIME_TEST_MODE,
    thresholds: trackerOptions.thresholds ?? screenTime.SCREEN_TIME_THRESHOLDS,
  });
  const advance = (ms, { activity = false, tick = true } = {}) => {
    perf += ms;
    wall += ms;
    if (activity) tracker.recordActivity();
    if (tick) tracker.tick();
  };
  const runActiveMinutes = (count) => { for (let i = 0; i < count; i += 1) advance(60_000, { activity: true }); };
  return {
    tracker, storage, reminders, doc, win, clock, advance, runActiveMinutes,
    setFocused(value) { focused = value; }, setWall(value) { wall = value; }, getWall: () => wall,
    getScheduled: () => scheduled,
  };
}

test("active time dihitung memakai delta monotonic dan hanya berjalan ketika engaged", () => {
  const h = harness();
  h.tracker.start();
  h.advance(90_000, { activity: true });
  h.advance(60_000, { activity: true });
  assert.equal(h.tracker.getState().activeMs, 150_000);
  assert.equal(h.tracker.getState().lastActiveAt, h.getWall());
  h.tracker.stop();
});

test("tab hidden dan blur menghentikan hitungan; kembali visible/focus melanjutkan", () => {
  const h = harness();
  h.tracker.start();
  h.advance(60_000, { activity: true });
  h.setFocused(false);
  h.win.dispatch("blur");
  h.advance(25 * 60_000);
  assert.equal(h.tracker.getState().activeMs, 60_000);
  h.setFocused(true);
  h.win.dispatch("focus");
  h.doc.visibilityState = "hidden";
  h.doc.dispatch("visibilitychange");
  h.advance(10 * 60_000);
  assert.equal(h.tracker.getState().activeMs, 60_000);
  h.doc.visibilityState = "visible";
  h.doc.dispatch("visibilitychange");
  h.advance(60_000, { activity: true });
  assert.equal(h.tracker.getState().activeMs, 120_000);
  h.tracker.stop();
});

test("idle lebih dari lima menit hanya menghitung sampai batas idle lalu pulih pada aktivitas", () => {
  const h = harness();
  h.tracker.start();
  h.advance(6 * 60_000);
  assert.equal(h.tracker.getState().activeMs, 5 * 60_000);
  h.advance(60_000, { activity: true });
  assert.equal(h.tracker.getState().activeMs, 5 * 60_000);
  h.advance(60_000, { activity: true });
  assert.equal(h.tracker.getState().activeMs, 6 * 60_000);
  h.tracker.stop();
});

test("mode asli aktif: ambang pertama muncul tepat setelah tiga jam aktif", () => {
  assert.equal(screenTime.SCREEN_TIME_TEST_MODE, false);
  assert.equal(screenTime.SCREEN_TIME_THRESHOLDS[3], 10_800_000);
  assert.deepEqual(screenTime.SCREEN_TIME_PRODUCTION_THRESHOLDS, { 3: 10_800_000, 5: 18_000_000, 7: 25_200_000, 12: 43_200_000 });
  const h = harness();
  h.tracker.start();
  h.runActiveMinutes(179);
  assert.deepEqual(h.reminders, []);
  assert.equal(h.tracker.getState().activeMs, 10_740_000);
  h.advance(59_999, { activity: true });
  assert.deepEqual(h.reminders, []);
  h.advance(1, { activity: true });
  assert.deepEqual(h.reminders.map((item) => item.thresholdHours), [3]);
  assert.equal(h.tracker.getState().lastTriggeredThreshold, 3);
  h.advance(60_000, { activity: true });
  assert.deepEqual(h.reminders.map((item) => item.thresholdHours), [3]);
  h.tracker.stop();
});

test("override test satu menit memunculkan alert final level 12 tanpa lanjut", () => {
  const h = harness(null, {
    testMode: true,
    thresholds: { ...screenTime.SCREEN_TIME_PRODUCTION_THRESHOLDS, 3: 60_000 },
  });
  h.tracker.start();
  h.runActiveMinutes(1);
  assert.deepEqual(h.reminders.map((item) => item.thresholdHours), [12]);
  assert.equal(h.tracker.getState().lastTriggeredThreshold, 12);
  h.advance(60_000, { activity: true });
  assert.deepEqual(h.reminders.map((item) => item.thresholdHours), [12]);
  h.tracker.stop();
});

test("ambang 3/5/7/12 muncul berurutan satu kali saat test mode dimatikan", () => {
  const h = harness(null, { testMode: false, thresholds: { 3: 60_000, 5: 120_000, 7: 180_000, 12: 240_000 } });
  h.tracker.start();
  h.runActiveMinutes(4);
  assert.deepEqual(h.reminders.map((item) => item.thresholdHours), [3, 5, 7, 12]);
  for (let i = 0; i < 5; i += 1) h.advance(60_000, { activity: true });
  assert.deepEqual(h.reminders.map((item) => item.thresholdHours), [3, 5, 7, 12]);
  assert.equal(h.tracker.getState().lastTriggeredThreshold, 12);
  h.tracker.stop();
});

test("reload pada tanggal yang sama mempertahankan active time dan tidak mengulang ambang", () => {
  const h = harness(null, { testMode: false, thresholds: screenTime.SCREEN_TIME_PRODUCTION_THRESHOLDS });
  h.tracker.start();
  h.runActiveMinutes(180);
  assert.deepEqual(h.reminders.map((item) => item.thresholdHours), [3]);
  h.tracker.stop();
  const restored = screenTime.createScreenTimeTracker({
    storage: h.storage, clock: h.clock, documentRef: h.doc, windowRef: h.win,
    scheduler: { setInterval: () => 2, clearInterval() {} },
    dateKey: (epoch) => `day-${Math.floor(epoch / 86_400_000)}`,
    onReminder: (reminder) => h.reminders.push(reminder),
    testMode: false,
    thresholds: screenTime.SCREEN_TIME_PRODUCTION_THRESHOLDS,
  });
  restored.start();
  restored.tick();
  assert.equal(restored.getState().activeMs, 3 * 60 * 60_000);
  assert.deepEqual(h.reminders.map((item) => item.thresholdHours), [3]);
  restored.stop();
});

test("pergantian tanggal mereset counter dan ambang tanpa menghitung sela tengah malam", () => {
  const h = harness();
  h.tracker.start();
  h.advance(60_000, { activity: true });
  const nextDay = (Math.floor(h.getWall() / 86_400_000) + 1) * 86_400_000 + 1_000;
  h.setWall(nextDay);
  h.advance(20_000);
  const state = h.tracker.getState();
  assert.equal(state.activeMs, 0);
  assert.equal(state.lastTriggeredThreshold, 0);
  assert.equal(state.date, `day-${Math.floor(nextDay / 86_400_000)}`);
  h.tracker.stop();
});

test("storage korup tidak membuat tracker gagal start atau menyimpan state", () => {
  const h = harness("{broken-json");
  assert.doesNotThrow(() => h.tracker.start());
  h.advance(60_000, { activity: true });
  assert.equal(h.tracker.getState().activeMs, 60_000);
  assert.doesNotThrow(() => JSON.parse(h.storage.getItem(screenTime.SCREEN_TIME_KEY)));
  h.tracker.stop();
});

test("snooze 30 menit menjadwalkan ulang hanya pengingat 5 jam", () => {
  const h = harness(null, { testMode: false, thresholds: screenTime.SCREEN_TIME_PRODUCTION_THRESHOLDS });
  h.tracker.start();
  h.runActiveMinutes(300);
  assert.deepEqual(h.reminders.map((item) => item.thresholdHours), [3, 5]);
  assert.equal(h.tracker.snooze(30), true);
  assert.equal(h.tracker.getState().snoozeUntil, h.getWall() + 30 * 60_000);
  h.runActiveMinutes(29);
  assert.equal(h.reminders.length, 2);
  h.runActiveMinutes(1);
  assert.deepEqual(h.reminders.map((item) => item.thresholdHours), [3, 5, 5]);
  assert.equal(h.reminders.at(-1).snoozed, true);
  h.tracker.dismiss();
  assert.equal(h.tracker.getState().snoozeUntil, 0);
  h.tracker.stop();
});
