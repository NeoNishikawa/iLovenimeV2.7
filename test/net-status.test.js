const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let netStatus;
test.before(async () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/js/net-status.js"), "utf8");
  netStatus = await import(`data:text/javascript,${encodeURIComponent(source)}`);
});

function fakeBrowser({ online = true, effectiveType = "4g", downlink = 10 } = {}) {
  const windowListeners = new Map();
  const connectionListeners = new Map();
  const connection = {
    effectiveType,
    downlink,
    saveData: false,
    addEventListener: (type, fn) => connectionListeners.set(type, fn),
  };
  return {
    navigatorRef: { onLine: online, connection },
    windowRef: {
      addEventListener: (type, fn) => windowListeners.set(type, fn),
      fire: (type) => windowListeners.get(type)?.(),
    },
    fireConnection: () => connectionListeners.get("change")?.(),
  };
}

function fakeBadge() {
  const use = { attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } };
  const root = {
    dataset: {},
    title: "",
    ariaLabel: "",
    attrs: {},
    setAttribute(key, value) { this.attrs[key] = value; if (key === "aria-label") this.ariaLabel = value; },
    querySelector: () => use,
  };
  const documentRef = { getElementById: (id) => (id === "netStatus" ? root : null) };
  return { root, use, documentRef };
}

test("klasifikasi jaringan: offline menang atas semua sinyal lain", () => {
  assert.equal(netStatus.classifyNetwork({ online: false }), "offline");
  assert.equal(netStatus.classifyNetwork({ online: false, effectiveType: "4g", downlink: 100 }), "offline");
  /* Tidak ada data navigasi sama sekali bukan alasan menyebut lambat. */
  assert.equal(netStatus.classifyNetwork({}), "good");
});

test("klasifikasi jaringan: 2g/3g dan downlink rendah dihitung lambat", () => {
  assert.equal(netStatus.classifyNetwork({ effectiveType: "slow-2g" }), "slow");
  assert.equal(netStatus.classifyNetwork({ effectiveType: "2g" }), "slow");
  assert.equal(netStatus.classifyNetwork({ effectiveType: "3g" }), "slow");
  assert.equal(netStatus.classifyNetwork({ effectiveType: "4g", downlink: 1.2 }), "slow");
  assert.equal(netStatus.classifyNetwork({ effectiveType: "4g", downlink: 10 }), "good");
  /* downlink 0 = belum dilaporkan browser, bukan jaringan lambat. */
  assert.equal(netStatus.classifyNetwork({ effectiveType: "4g", downlink: 0 }), "good");
});

test("klasifikasi jaringan: latensi API nyata jadi sinyal lambat", () => {
  assert.equal(netStatus.classifyNetwork({ effectiveType: "4g", latencyMs: 3200 }), "slow");
  assert.equal(netStatus.classifyNetwork({ effectiveType: "4g", latencyMs: 400 }), "good");
});

test("monitor melaporkan perubahan status ke subscriber", () => {
  const fake = fakeBrowser();
  const monitor = netStatus.createNetworkMonitor({ navigatorRef: fake.navigatorRef, windowRef: fake.windowRef });
  monitor.start();
  const seen = [];
  monitor.subscribe((snapshot) => seen.push(snapshot.state));
  assert.deepEqual(seen, ["good"]);
  fake.navigatorRef.onLine = false;
  fake.windowRef.fire("offline");
  fake.navigatorRef.onLine = true;
  fake.windowRef.fire("online");
  assert.deepEqual(seen, ["good", "offline", "good"]);
  fake.navigatorRef.connection.effectiveType = "3g";
  fake.fireConnection();
  assert.equal(seen.at(-1), "slow");
});

test("setLatency hanya menerbitkan ulang saat angkanya benar-benar berubah", () => {
  const fake = fakeBrowser();
  const monitor = netStatus.createNetworkMonitor({ navigatorRef: fake.navigatorRef, windowRef: fake.windowRef });
  const seen = [];
  monitor.subscribe((snapshot) => seen.push(snapshot.latencyMs));
  monitor.setLatency(3000);
  monitor.setLatency(3000);
  monitor.setLatency(Number.NaN);
  assert.deepEqual(seen, [null, 3000, null]);
  assert.equal(monitor.get().state, "good");
});

test("badge ikon hanya ikon: menukar simbol wifi dan menulis label status", () => {
  const fake = fakeBrowser();
  const { root, use, documentRef } = fakeBadge();
  const monitor = netStatus.createNetworkMonitor({ navigatorRef: fake.navigatorRef, windowRef: fake.windowRef });
  monitor.start();
  netStatus.mountNetworkBadge({ monitor, documentRef });
  assert.equal(root.dataset.net, "good");
  assert.equal(root.dataset.icon, "on");
  assert.equal(use.attrs.href, "#i-wifi");
  assert.equal(root.ariaLabel, "Jaringan baik");
  fake.navigatorRef.onLine = false;
  fake.windowRef.fire("offline");
  assert.equal(root.dataset.net, "offline");
  assert.equal(use.attrs.href, "#i-wifi-off");
  assert.equal(root.ariaLabel, "Offline");
  fake.navigatorRef.onLine = true;
  fake.navigatorRef.connection.effectiveType = "2g";
  monitor.setLatency(3200);
  assert.equal(root.dataset.net, "slow");
  assert.equal(use.attrs.href, "#i-wifi");
  assert.equal(root.ariaLabel, "Jaringan lambat · 3.2s");
});