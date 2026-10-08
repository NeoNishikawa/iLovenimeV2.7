if (typeof globalThis.registerSeal === "function") globalThis.registerSeal("perfmode", "copyright LoveNime");
export const PERFORMANCE_MODE_KEY = "iln:performance-mode";
export const PERFORMANCE_MODES = Object.freeze(["auto", "full", "balanced", "low"]);
const TIERS = ["low", "balanced", "full"];

export function initialPerformanceTier(mode, { hardwareConcurrency = 8, deviceMemory = 8, reducedMotion = false } = {}) {
  if (mode === "low" || reducedMotion) return "low";
  if (mode === "balanced") return "balanced";
  if (mode === "full") return "full";
  return Number(hardwareConcurrency) <= 4 || Number(deviceMemory) <= 4 ? "balanced" : "full";
}

export function performanceConfig(tier, isSmall = false) {
  if (tier === "low") return { tier: "low", targetFps: 0, particleCount: 0 };
  if (tier === "balanced") return { tier, targetFps: 30, particleCount: isSmall ? 70 : 140 };
  return { tier: "full", targetFps: 60, particleCount: isSmall ? 140 : 320 };
}

export function createPerformanceController({
  storage = globalThis.localStorage,
  documentRef = globalThis.document,
  navigatorRef = globalThis.navigator,
  onChange = () => {},
  sampleWindow = 60,
} = {}) {
  let mode = "auto";
  try {
    const saved = storage?.getItem(PERFORMANCE_MODE_KEY);
    if (PERFORMANCE_MODES.includes(saved)) mode = saved;
  } catch { /* storage may be unavailable */ }
  const reducedMotion = Boolean(documentRef?.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  let tier = initialPerformanceTier(mode, {
    hardwareConcurrency: navigatorRef?.hardwareConcurrency || 8,
    deviceMemory: navigatorRef?.deviceMemory || 8,
    reducedMotion,
  });
  let sampleCount = 0;
  let totalFrameMs = 0;
  let slowFrames = 0;

  const publish = () => {
    const root = documentRef?.documentElement;
    if (root) {
      root.dataset.performanceMode = mode;
      root.dataset.performanceTier = tier;
    }
    const detail = { mode, tier, config: performanceConfig(tier) };
    try { onChange(detail); } catch { /* UI adaptation must not break rendering */ }
    if (documentRef?.dispatchEvent && typeof globalThis.CustomEvent === "function") {
      documentRef.dispatchEvent(new CustomEvent("iln:performance-change", { detail }));
    }
    return detail;
  };
  const resetSamples = () => { sampleCount = 0; totalFrameMs = 0; slowFrames = 0; };
  const setTier = (next) => {
    if (tier === next) return;
    tier = next;
    resetSamples();
    publish();
  };
  const setMode = (next) => {
    if (!PERFORMANCE_MODES.includes(next)) return false;
    mode = next;
    try { storage?.setItem(PERFORMANCE_MODE_KEY, mode); } catch { /* storage may be unavailable */ }
    setTier(initialPerformanceTier(mode, {
      hardwareConcurrency: navigatorRef?.hardwareConcurrency || 8,
      deviceMemory: navigatorRef?.deviceMemory || 8,
      reducedMotion,
    }));
    publish();
    return true;
  };
  const reportFrame = (frameMs) => {
    if (mode !== "auto" || tier === "low" || !Number.isFinite(frameMs) || frameMs <= 0) return tier;
    totalFrameMs += frameMs;
    if (frameMs > 25) slowFrames += 1;
    sampleCount += 1;
    if (sampleCount < sampleWindow) return tier;
    const average = totalFrameMs / sampleCount;
    const slowRatio = slowFrames / sampleCount;
    if (average >= 28 || slowRatio >= 0.22) {
      setTier(tier === "full" ? "balanced" : "low");
    } else if (average <= 18 && slowRatio <= 0.05 && tier === "balanced") {
      setTier("full");
    } else {
      resetSamples();
    }
    return tier;
  };

  publish();
  return { getMode: () => mode, getTier: () => tier, setMode, reportFrame, getConfig: () => performanceConfig(tier) };
}
