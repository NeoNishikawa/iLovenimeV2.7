if (typeof globalThis.registerSeal === "function") globalThis.registerSeal("netstatus", "copyright LoveNime");
/* ==========================================================================
   ILoveNime — Status jaringan (badge ikon wifi di header)
   Sumber kebenaran: navigator.onLine + Network Information API (effectiveType
   / downlink / saveData) + latensi nyata yang dilaporkan pemanggil setelah
   satu panggilan API selesai. Tanpa library, tanpa polling.
   ========================================================================== */
export const NETWORK_STATES = Object.freeze(["offline", "slow", "good"]);
export const NETWORK_LABEL = Object.freeze({ good: "Jaringan baik", slow: "Jaringan lambat", offline: "Offline" });
/* effectiveType ini dianggap "lambat" untuk kebutuhan streaming anime:
   3g sudah tidak layak untuk memutar episode. */
const SLOW_TYPES = new Set(["slow-2g", "2g", "3g"]);
const SLOW_DOWNLINK = 1.5;
const SLOW_LATENCY_MS = 2500;

/* Fungsi murni: input nav → salah satu dari NETWORK_STATES. */
export function classifyNetwork({ online = true, effectiveType = "", downlink = Number.NaN, latencyMs = null } = {}) {
  if (!online) return "offline";
  if (SLOW_TYPES.has(String(effectiveType).toLowerCase())) return "slow";
  const link = Number(downlink);
  if (Number.isFinite(link) && link > 0 && link < SLOW_DOWNLINK) return "slow";
  const latency = Number(latencyMs);
  if (Number.isFinite(latency) && latency >= SLOW_LATENCY_MS) return "slow";
  return "good";
}

function connectionOf(navigatorRef) {
  return navigatorRef?.connection || navigatorRef?.mozConnection || navigatorRef?.webkitConnection || null;
}

export function createNetworkMonitor({
  navigatorRef = globalThis.navigator,
  windowRef = globalThis.window,
  latencyMs = null,
} = {}) {
  /* null/undefined berarti "belum ada pengukuran", bukan 0 ms — kalau tidak
     dibedakan, badge akan sempat melapor 0 dan langsung mengira jaringan bagus. */
  let latency = latencyMs === null || latencyMs === undefined ? null : (Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null);
  const listeners = new Set();

  const sample = () => {
    const connection = connectionOf(navigatorRef);
    const online = navigatorRef?.onLine !== false;
    const effectiveType = String(connection?.effectiveType || "");
    const downlink = Number(connection?.downlink);
    const state = classifyNetwork({ online, effectiveType, downlink, latencyMs: latency });
    return { online, effectiveType, downlink, saveData: Boolean(connection?.saveData), latencyMs: latency, state };
  };
  const publish = () => {
    const snapshot = sample();
    for (const listener of listeners) { try { listener(snapshot); } catch { /* satu listener gagal tidak boleh mematikan yang lain */ } }
    return snapshot;
  };
  const subscribe = (listener) => {
    if (typeof listener !== "function") return () => { };
    listeners.add(listener);
    listener(sample());
    return () => listeners.delete(listener);
  };
  /* Dipanggil setelah satu request API selesai: latensi nyata mengalahkan
     tebakan effectiveType, tapi tidak pernah mengalahkan status offline. */
  const setLatency = (ms) => {
    const next = Number(ms);
    const safe = Number.isFinite(next) && next >= 0 ? next : null;
    if (safe === latency) return sample();
    latency = safe;
    return publish();
  };
  const start = () => {
    windowRef?.addEventListener?.("online", publish);
    windowRef?.addEventListener?.("offline", publish);
    connectionOf(navigatorRef)?.addEventListener?.("change", publish);
    return publish();
  };

  return { get: sample, publish, subscribe, setLatency, start };
}

/* Badge ikon saja: ikon wifi untuk ada jaringan, ikon wifi-off saat offline,
   warna emas saat lambat, hijau saat baik. */
export function mountNetworkBadge({ monitor, documentRef = globalThis.document, id = "netStatus" } = {}) {
  const root = documentRef?.getElementById?.(id);
  if (!root || !monitor) return () => { };
  const labelFor = (snapshot) => {
    const base = NETWORK_LABEL[snapshot.state] || NETWORK_LABEL.good;
    if (snapshot.state !== "slow" || !Number.isFinite(Number(snapshot.latencyMs))) return base;
    return `${base} · ${Math.round(Number(snapshot.latencyMs) / 100) / 10}s`;
  };
  return monitor.subscribe((snapshot) => {
    const offline = snapshot.state === "offline";
    root.dataset.net = snapshot.state;
    root.dataset.icon = offline ? "off" : "on";
    const use = root.querySelector("use");
    if (use) use.setAttribute("href", offline ? "#i-wifi-off" : "#i-wifi");
    const label = labelFor(snapshot);
    root.title = label;
    root.setAttribute("aria-label", label);
  });
}