if (typeof globalThis.registerSeal === "function") globalThis.registerSeal("ambient", "copyright LoveNime");
/* Lazily loaded Three.js ambience with one cancellable RAF loop. */
import { performanceConfig } from "./performance-mode.js";

const doc = document;
const win = window;
const motionQuery = win.matchMedia("(prefers-reduced-motion: reduce)");
const IDLE_AFTER_MS = 5 * 60_000;
let renderer = null;
let scene = null;
let camera = null;
let points = null;
let geometry = null;
let material = null;
let sprite = null;
let rafId = null;
let idleTimer = null;
let initPromise = null;
let running = false;
let isIdle = false;
let lastInteraction = performance.now();
let lastFrame = 0;
let lastRender = 0;
let targetFps = 60;
let currentTier = doc.documentElement.dataset.performanceTier || "full";
let particleSeed = null;
let particleOrigin = null;

function currentConfig() {
  currentTier = doc.documentElement.dataset.performanceTier || currentTier || "full";
  const small = win.innerWidth < 768;
  return performanceConfig(currentTier, small);
}
function getCanvas() {
  let canvas = doc.getElementById("ambientCanvas");
  if (!canvas) {
    canvas = doc.createElement("canvas");
    canvas.id = "ambientCanvas";
    canvas.setAttribute("aria-hidden", "true");
    doc.body.prepend(canvas);
  }
  canvas.style.cssText = "position:fixed;inset:0;z-index:-2;width:100%;height:100%;pointer-events:none;opacity:.5";
  return canvas;
}
function stopLoop() {
  running = false;
  if (rafId !== null) win.cancelAnimationFrame(rafId);
  rafId = null;
}
function disposeRenderer() {
  stopLoop();
  geometry?.dispose();
  material?.dispose();
  sprite?.dispose();
  renderer?.dispose();
  renderer?.domElement?.remove();
  renderer = scene = camera = points = geometry = material = sprite = null;
  particleSeed = particleOrigin = null;
}
function resize() {
  if (!renderer) return;
  const width = Math.max(1, win.innerWidth);
  const height = Math.max(1, win.innerHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
function makeSprite(THREE) {
  const canvas = doc.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,235,150,1)");
  gradient.addColorStop(0.4, "rgba(255,200,60,.55)");
  gradient.addColorStop(1, "rgba(255,180,20,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
function setParticleCount(THREE, count, small) {
  if (!renderer) return;
  if (geometry?.attributes.position.count === count && material?.size === (small ? 0.16 : 0.2)) return;
  const positions = new Float32Array(count * 3);
  particleSeed = new Float32Array(count);
  particleOrigin = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const x = (Math.random() - 0.5) * 36;
    const y = (Math.random() - 0.5) * 22;
    const z = (Math.random() - 0.5) * 12;
    positions.set([x, y, z], i * 3);
    particleOrigin.set([x, y, z], i * 3);
    particleSeed[i] = Math.random() * Math.PI * 2;
  }
  geometry?.dispose();
  geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (!material) {
    sprite = makeSprite(THREE);
    material = new THREE.PointsMaterial({
      size: small ? 0.16 : 0.2,
      map: sprite,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: new THREE.Color("#FFD700"),
      sizeAttenuation: true,
    });
  } else {
    material.size = small ? 0.16 : 0.2;
  }
  if (!points) {
    points = new THREE.Points(geometry, material);
    scene.add(points);
  } else {
    points.geometry = geometry;
  }
}
function renderFrame(now) {
  rafId = null;
  if (!running || doc.hidden || isIdle || motionQuery.matches || currentTier === "low") return;
  const delta = lastFrame ? now - lastFrame : 16.7;
  lastFrame = now;
  win.ilnPerformanceController?.reportFrame(delta);
  if (!running || currentTier === "low") return;
  const interval = 1000 / Math.max(1, targetFps);
  if (!lastRender || now - lastRender >= interval - 0.5) {
    lastRender = now;
    const time = now / 1000;
    const attr = geometry.attributes.position;
    for (let i = 0; i < particleSeed.length; i += 1) {
      const seed = particleSeed[i];
      const idx = i * 3;
      attr.array[idx] = particleOrigin[idx] + Math.cos(time * 0.22 + seed) * 0.35;
      attr.array[idx + 1] = ((particleOrigin[idx + 1] + time * 0.14 + Math.sin(time * 0.35 + seed) * 0.22 + 11) % 22) - 11;
    }
    attr.needsUpdate = true;
    points.rotation.y = Math.sin(time * 0.05) * 0.08;
    renderer.render(scene, camera);
  }
  if (running && rafId === null) rafId = win.requestAnimationFrame(renderFrame);
}
function startLoop() {
  if (!renderer || running || doc.hidden || isIdle || motionQuery.matches || currentTier === "low") return;
  running = true;
  lastFrame = 0;
  lastRender = 0;
  rafId = win.requestAnimationFrame(renderFrame);
}
async function initialize() {
  if (renderer || initPromise || motionQuery.matches || currentTier === "low" || doc.hidden || isIdle) return;
  initPromise = (async () => {
    try {
      const THREE = await import("three");
      if (motionQuery.matches || currentTier === "low" || doc.hidden || isIdle) return;
      const canvas = getCanvas();
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: "low-power" });
      renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 1.5));
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.z = 14;
      const config = currentConfig();
      targetFps = config.targetFps || 60;
      setParticleCount(THREE, config.particleCount, win.innerWidth < 768);
      resize();
      startLoop();
    } catch {
      doc.getElementById("ambientCanvas")?.remove();
    } finally {
      initPromise = null;
    }
  })();
  await initPromise;
}
function scheduleIdleLoad() {
  if (motionQuery.matches || currentTier === "low" || doc.hidden || isIdle) return;
  const load = () => { if (!isIdle && !doc.hidden && !motionQuery.matches && currentTier !== "low") initialize(); };
  if ("requestIdleCallback" in win) win.requestIdleCallback(load, { timeout: 1800 });
  else win.setTimeout(load, 700);
}
function resetIdleTimer() {
  lastInteraction = performance.now();
  isIdle = false;
  win.clearTimeout(idleTimer);
  idleTimer = win.setTimeout(() => {
    if (performance.now() - lastInteraction >= IDLE_AFTER_MS) {
      isIdle = true;
      stopLoop();
    }
  }, IDLE_AFTER_MS + 50);
  if (!renderer) scheduleIdleLoad();
  else startLoop();
}
function applyTier(detail = {}) {
  const nextTier = detail.tier || doc.documentElement.dataset.performanceTier || "full";
  const changed = nextTier !== currentTier;
  currentTier = nextTier;
  if (currentTier === "low" || motionQuery.matches) {
    disposeRenderer();
    doc.getElementById("ambientCanvas")?.remove();
    return;
  }
  const config = currentConfig();
  targetFps = config.targetFps;
  if (renderer && changed) {
    import("three").then((THREE) => setParticleCount(THREE, config.particleCount, win.innerWidth < 768));
  }
  if (renderer) startLoop();
  else scheduleIdleLoad();
}

currentTier = doc.documentElement.dataset.performanceTier || "full";
if (motionQuery.matches || currentTier === "low") doc.getElementById("ambientCanvas")?.remove();
else resetIdleTimer();

doc.addEventListener("visibilitychange", () => {
  if (doc.hidden) stopLoop();
  else if (!isIdle) { if (renderer) startLoop(); else scheduleIdleLoad(); }
});
doc.addEventListener("iln:performance-change", (event) => applyTier(event.detail));
for (const eventName of ["pointerdown", "keydown", "touchstart", "scroll"]) {
  doc.addEventListener(eventName, resetIdleTimer, eventName === "scroll" || eventName === "touchstart" ? { passive: true } : undefined);
}
win.addEventListener("resize", () => {
  resize();
  if (renderer) {
    const config = currentConfig();
    import("three").then((THREE) => setParticleCount(THREE, config.particleCount, win.innerWidth < 768));
    targetFps = config.targetFps;
  }
});
motionQuery.addEventListener?.("change", () => applyTier({ tier: doc.documentElement.dataset.performanceTier || currentTier }));
