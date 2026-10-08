if (typeof globalThis.registerSeal === "function") globalThis.registerSeal("screentime", "copyright LoveNime");
export const SCREEN_TIME_KEY = "iln:screen-time";
export const SCREEN_TIME_TEST_MODE = false;
export const SCREEN_TIME_PRODUCTION_THRESHOLDS = Object.freeze({ 3: 10_800_000, 5: 18_000_000, 7: 25_200_000, 12: 43_200_000 });
export const SCREEN_TIME_THRESHOLDS = Object.freeze({
  ...SCREEN_TIME_PRODUCTION_THRESHOLDS,
  3: SCREEN_TIME_TEST_MODE ? 60_000 : SCREEN_TIME_PRODUCTION_THRESHOLDS[3],
});
export const SCREEN_TIME_IDLE_MS = 5 * 60_000;
export const SCREEN_TIME_SNOOZE_MS = 30 * 60_000;
const SCHEDULER_MS = 45_000;

function localDateKey(epochMs) {
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function freshState(date, enabled = true) {
  return { date, activeMs: 0, lastActiveAt: 0, lastTriggeredThreshold: 0, snoozeUntil: 0, enabled };
}

function normalizeState(raw, date) {
  if (!raw || typeof raw !== "object" || raw.date !== date) return freshState(date, raw?.enabled !== false);
  const threshold = Number(raw.lastTriggeredThreshold);
  return {
    date,
    activeMs: Number.isFinite(Number(raw.activeMs)) ? Math.max(0, Number(raw.activeMs)) : 0,
    lastActiveAt: Number.isFinite(Number(raw.lastActiveAt)) ? Math.max(0, Number(raw.lastActiveAt)) : 0,
    lastTriggeredThreshold: [0, 3, 5, 7, 12].includes(threshold) ? threshold : 0,
    snoozeUntil: Number.isFinite(Number(raw.snoozeUntil)) ? Math.max(0, Number(raw.snoozeUntil)) : 0,
    enabled: raw.enabled !== false,
  };
}

/**
 * Local-only active-time tracker. Time deltas use a monotonic clock; wall time
 * is used only for local calendar-day boundaries, persistence, and snoozes.
 */
export function createScreenTimeTracker({
  storage = globalThis.localStorage,
  clock = { performanceNow: () => performance.now(), wallNow: () => Date.now() },
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  scheduler = globalThis,
  onReminder = () => {},
  idleMs = SCREEN_TIME_IDLE_MS,
  testMode = SCREEN_TIME_TEST_MODE,
  intervalMs = testMode ? 1_000 : SCHEDULER_MS,
  storageKey = SCREEN_TIME_KEY,
  dateKey = localDateKey,
  thresholds = SCREEN_TIME_THRESHOLDS,
} = {}) {
  const readStored = () => {
    const today = dateKey(clock.wallNow());
    try { return normalizeState(JSON.parse(storage?.getItem(storageKey) || "null"), today); }
    catch { return freshState(today); }
  };
  let state = readStored();
  let started = false;
  let visible = true;
  let focused = true;
  let lastPerf = clock.performanceNow();
  let lastActivityPerf = lastPerf;
  let lastPersistWall = clock.wallNow();
  let timer = null;
  const listeners = [];

  const persist = (force = false) => {
    const nowWall = clock.wallNow();
    if (!force && nowWall - lastPersistWall < 15_000) return;
    try { storage?.setItem(storageKey, JSON.stringify(state)); lastPersistWall = nowWall; } catch { /* storage may be disabled or full */ }
  };
  const cloneState = () => ({ ...state });
  const attach = (target, eventName, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(eventName, handler, options);
    listeners.push(() => target.removeEventListener(eventName, handler, options));
  };
  const resetForDate = (today, nowPerf) => {
    state = freshState(today, state.enabled);
    lastPerf = nowPerf;
    lastActivityPerf = nowPerf;
    persist(true);
  };
  const rollDateIfNeeded = (nowPerf, nowWall) => {
    const today = dateKey(nowWall);
    if (today === state.date) return false;
    resetForDate(today, nowPerf);
    return true;
  };
  const advance = (nowPerf, nowWall = clock.wallNow()) => {
    if (rollDateIfNeeded(nowPerf, nowWall)) return;
    if (state.enabled && visible && focused) {
      const countUntil = Math.min(nowPerf, lastActivityPerf + idleMs);
      const from = Math.max(lastPerf, lastActivityPerf);
      if (countUntil > from) state.activeMs += countUntil - from;
    }
    lastPerf = nowPerf;
    persist();
  };
  const emitReminder = (hours, snoozed = false) => {
    const reminder = { thresholdHours: hours, activeMs: state.activeMs, date: state.date, snoozed };
    try { onReminder(reminder); } catch { /* reminders must never break time accounting */ }
  };
  const checkThresholds = (nowWall = clock.wallNow()) => {
    if (!state.enabled) return;
    if (testMode && state.activeMs >= thresholds[3] && state.lastTriggeredThreshold < 12) {
      state.lastTriggeredThreshold = 12;
      state.snoozeUntil = 0;
      persist(true);
      emitReminder(12);
      return;
    }
    if (state.activeMs >= thresholds[12] && state.lastTriggeredThreshold < 12) {
      state.lastTriggeredThreshold = 12;
      state.snoozeUntil = 0;
      persist(true);
      emitReminder(12);
      return;
    }
    if (state.activeMs >= thresholds[7] && state.lastTriggeredThreshold < 7) {
      state.lastTriggeredThreshold = 7;
      state.snoozeUntil = 0;
      persist(true);
      emitReminder(7);
      return;
    }
    if (state.lastTriggeredThreshold < 5 && state.activeMs >= thresholds[5]) {
      state.lastTriggeredThreshold = 5;
      state.snoozeUntil = 0;
      persist(true);
      emitReminder(5);
      return;
    }
    if (state.lastTriggeredThreshold === 5 && state.snoozeUntil && nowWall >= state.snoozeUntil && state.activeMs >= thresholds[5]) {
      state.snoozeUntil = 0;
      persist(true);
      emitReminder(5, true);
      return;
    }
    if (state.lastTriggeredThreshold < 3 && state.activeMs >= thresholds[3]) {
      state.lastTriggeredThreshold = 3;
      persist(true);
      emitReminder(3);
    }
  };
  const recordActivity = () => {
    if (!started) return;
    const nowPerf = clock.performanceNow();
    const nowWall = clock.wallNow();
    advance(nowPerf, nowWall);
    if (!visible || !focused || !state.enabled) return;
    lastActivityPerf = nowPerf;
    state.lastActiveAt = nowWall;
    lastPerf = nowPerf;
    persist();
    checkThresholds(nowWall);
  };
  const onVisibilityChange = () => {
    const nowPerf = clock.performanceNow();
    advance(nowPerf);
    visible = documentRef?.visibilityState === "visible";
    lastPerf = nowPerf;
    lastActivityPerf = nowPerf;
    if (visible && focused && state.enabled) state.lastActiveAt = clock.wallNow();
    persist();
  };
  const onFocus = () => {
    const nowPerf = clock.performanceNow();
    advance(nowPerf);
    focused = true;
    lastPerf = nowPerf;
    lastActivityPerf = nowPerf;
    if (visible && state.enabled) state.lastActiveAt = clock.wallNow();
    persist();
  };
  const onBlur = () => {
    const nowPerf = clock.performanceNow();
    advance(nowPerf);
    focused = false;
    lastPerf = nowPerf;
    persist();
  };

  const tick = () => {
    if (!started) return;
    const nowPerf = clock.performanceNow();
    const nowWall = clock.wallNow();
    advance(nowPerf, nowWall);
    checkThresholds(nowWall);
  };
  const start = () => {
    if (started) return api;
    started = true;
    visible = documentRef?.visibilityState ? documentRef.visibilityState === "visible" : true;
    focused = typeof documentRef?.hasFocus === "function" ? documentRef.hasFocus() : true;
    lastPerf = clock.performanceNow();
    lastActivityPerf = lastPerf;
    if (visible && focused && state.enabled) state.lastActiveAt = clock.wallNow();
    attach(documentRef, "visibilitychange", onVisibilityChange);
    attach(windowRef, "focus", onFocus);
    attach(windowRef, "blur", onBlur);
    for (const eventName of ["pointerdown", "keydown", "touchstart", "scroll"]) {
      attach(documentRef, eventName, recordActivity, eventName === "scroll" || eventName === "touchstart" ? { passive: true } : undefined);
    }
    timer = scheduler?.setInterval?.(tick, intervalMs) ?? null;
    checkThresholds(clock.wallNow());
    return api;
  };
  const stop = () => {
    if (!started) return;
    advance(clock.performanceNow(), clock.wallNow());
    started = false;
    if (timer !== null) scheduler?.clearInterval?.(timer);
    timer = null;
    listeners.splice(0).forEach((remove) => remove());
  };
  const snooze = (minutes = 30) => {
    if (state.lastTriggeredThreshold !== 5) return false;
    state.snoozeUntil = clock.wallNow() + Math.max(1, Number(minutes) || 30) * 60_000;
    persist(true);
    return true;
  };
  const dismiss = () => {
    state.snoozeUntil = 0;
    persist(true);
  };
  const setEnabled = (enabled) => {
    const nowPerf = clock.performanceNow();
    advance(nowPerf, clock.wallNow());
    state.enabled = Boolean(enabled);
    lastPerf = nowPerf;
    lastActivityPerf = nowPerf;
    persist(true);
    if (state.enabled) checkThresholds(clock.wallNow());
  };
  const api = { start, stop, tick, recordActivity, snooze, dismiss, setEnabled, getState: cloneState };
  return api;
}

const reminderCopy = {
  3: {
    image: "/assets/screen-time/3hours.png",
    title: "Waktunya istirahat sejenak",
    body: "Istirahatkan mata dan tubuhmu sebentar, atau lanjutkan jika masih perlu.",
    alt: "Karakter mengingatkan untuk beristirahat",
  },
  5: {
    image: "/assets/screen-time/5hours.png",
    title: "Saatnya istirahat sejenak",
    body: "Kamu sudah aktif selama 5 jam hari ini. Beri mata dan tubuhmu jeda sebentar.",
    alt: "Karakter mengingatkan untuk beristirahat setelah lima jam",
  },
  7: {
    image: "/assets/screen-time/7hours.png",
    title: "Sudah 7 jam — waktunya rehat",
    body: "Kamu telah aktif cukup lama hari ini. Pertimbangkan untuk menjauh dari layar dan beristirahat.",
    alt: "Karakter menangis mengingatkan agar beristirahat setelah tujuh jam",
  },
  12: {
    image: "/assets/screen-time/12hours.jpg",
    title: "Pengingat terakhir — tutup web sekarang",
    body: "Waktu layar hari ini sudah sangat panjang. Web akan mencoba menutup otomatis dalam 5 detik; notifikasi sistem hanya muncul jika izin browser aktif.",
    alt: "Karakter marah mengingatkan agar segera berhenti menggunakan layar",
  },
};

/** Mounts the centered level-3/5/7/12 reminders with focus management. */
export function mountScreenTimeUI({ tracker, documentRef = globalThis.document, windowRef = globalThis.window } = {}) {
  if (!documentRef?.body) return { show() {}, destroy() {} };
  const root = documentRef.createElement("div");
  root.className = "screen-time-root";
  root.innerHTML = `
    <div class="screen-time-overlay" data-screen-overlay hidden>
      <section class="screen-time-dialog" data-screen-dialog role="dialog" aria-modal="true" aria-labelledby="screen-time-title" aria-describedby="screen-time-description" tabindex="-1">
        <img class="screen-time-dialog__image" data-screen-image src="" alt="" width="168" height="168" />
        <p class="screen-time-eyebrow" data-screen-eyebrow>Pengingat waktu layar</p>
        <h2 id="screen-time-title" data-screen-title></h2>
        <p id="screen-time-description" class="screen-time-description" data-screen-description></p>
        <p class="screen-time-countdown" data-screen-countdown aria-live="polite" hidden></p>
        <div class="screen-time-actions" data-screen-actions></div>
      </section>
    </div>`;
  documentRef.body.appendChild(root);
  const overlay = root.querySelector("[data-screen-overlay]");
  const dialog = root.querySelector("[data-screen-dialog]");
  const image = root.querySelector("[data-screen-image]");
  const title = root.querySelector("[data-screen-title]");
  const description = root.querySelector("[data-screen-description]");
  const eyebrow = root.querySelector("[data-screen-eyebrow]");
  const countdown = root.querySelector("[data-screen-countdown]");
  const actions = root.querySelector("[data-screen-actions]");
  let returnFocus = null;
  let open = false;
  let continueTimer = null;
  let autoCloseTimer = null;

  const setEverySecond = (callback) => windowRef?.setInterval ? windowRef.setInterval(callback, 1_000) : globalThis.setInterval(callback, 1_000);
  const clearTimer = (timer) => {
    if (timer === null) return;
    if (windowRef?.clearInterval) windowRef.clearInterval(timer);
    else globalThis.clearInterval(timer);
  };
  const clearCountdownTimers = () => {
    clearTimer(continueTimer);
    clearTimer(autoCloseTimer);
    continueTimer = null;
    autoCloseTimer = null;
  };
  const formatCountdown = (totalSeconds) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  };
  const showSleepNotification = async (requestPermission) => {
    const NotificationApi = windowRef?.Notification;
    if (!NotificationApi) return "unsupported";
    let permission = NotificationApi.permission || "default";
    if (permission === "default" && requestPermission && typeof NotificationApi.requestPermission === "function") {
      try { permission = await NotificationApi.requestPermission(); } catch { permission = "error"; }
    }
    if (permission !== "granted") return permission;
    const message = "get some sleep, Love you 💖";
    const options = { body: message, icon: "/assets/screen-time/bell.svg", tag: "iln-screen-time-final", renotify: false };
    try {
      const registration = await windowRef?.ilnScreenTimeServiceWorker;
      if (typeof registration?.showNotification === "function") {
        await registration.showNotification("iLoveNime", options);
        return "shown";
      }
      new NotificationApi("iLoveNime", options);
      return "shown";
    } catch {
      try { new NotificationApi("iLoveNime", options); return "shown"; }
      catch { return "error"; }
    }
  };
  const closeWebsite = async ({ automatic = false } = {}) => {
    clearCountdownTimers();
    tracker?.dismiss();
    const closeButton = actions.querySelector('[data-screen-action="close-website"]');
    if (closeButton) closeButton.disabled = true;
    const notificationStatus = await showSleepNotification(!automatic);
    if (countdown) {
      countdown.hidden = false;
      countdown.textContent = "Mencoba menutup web…";
    }
    let closeAttempted = false;
    try {
      if (typeof windowRef?.close === "function") {
        closeAttempted = true;
        windowRef.close();
      }
    } catch { /* Browser policy may reject closing a tab the site did not open. */ }
    const showFallback = () => {
      if (closeAttempted && windowRef.closed) return;
      const notificationMessage = notificationStatus === "shown"
        ? "Notifikasi perangkat sudah dikirim."
        : "Notifikasi perangkat tidak tampil; izin browser mungkin belum diberikan.";
      description.textContent = `Browser tidak mengizinkan situs menutup tab ini. Tutup tab secara manual. ${notificationMessage}`;
      if (countdown) {
        countdown.hidden = false;
        countdown.textContent = "Penutupan otomatis diblokir browser.";
      }
      if (closeButton) {
        closeButton.disabled = false;
        closeButton.focus();
      }
    };
    if (windowRef?.setTimeout) windowRef.setTimeout(showFallback, 350);
    else globalThis.setTimeout(showFallback, 350);
  };

  const closeDialog = () => {
    if (!open) return;
    open = false;
    clearCountdownTimers();
    overlay.hidden = true;
    countdown.hidden = true;
    countdown.textContent = "";
    actions.replaceChildren();
    const target = returnFocus;
    returnFocus = null;
    if (target?.isConnected && typeof target.focus === "function") target.focus();
  };
  const button = (label, action, primary = false) => {
    const node = documentRef.createElement("button");
    node.type = "button";
    node.className = `screen-time-btn${primary ? " is-primary" : ""}`;
    node.dataset.screenAction = action;
    node.textContent = label;
    return node;
  };
  const formatActiveTime = (activeMs) => {
    const hours = Math.floor(Math.max(0, Number(activeMs) || 0) / 3_600_000);
    const minutes = Math.floor((Math.max(0, Number(activeMs) || 0) % 3_600_000) / 60_000);
    return hours ? `${hours} jam` : minutes ? `${minutes} menit` : "kurang dari 1 menit";
  };
  const startContinueCountdown = (continueButton, seconds) => {
    let remaining = seconds;
    countdown.hidden = false;
    const render = () => {
      if (remaining <= 0) {
        continueButton.disabled = false;
        continueButton.textContent = "Lanjutkan";
        countdown.textContent = "Waktu istirahat selesai. Kamu dapat melanjutkan sekarang.";
        clearTimer(continueTimer);
        continueTimer = null;
        return;
      }
      continueButton.disabled = true;
      continueButton.textContent = `Lanjutkan (${formatCountdown(remaining)})`;
      if (remaining === seconds) countdown.textContent = `Tombol Lanjutkan terbuka dalam ${formatCountdown(seconds)}. Istirahat sejenak dulu.`;
    };
    render();
    continueTimer = setEverySecond(() => { remaining -= 1; render(); });
  };
  const startFinalCountdown = () => {
    let remaining = 5;
    countdown.hidden = false;
    const render = () => {
      if (remaining <= 0) {
        clearTimer(autoCloseTimer);
        autoCloseTimer = null;
        countdown.textContent = "Mencoba menutup web…";
        void closeWebsite({ automatic: true });
        return;
      }
      countdown.textContent = `Web akan ditutup otomatis dalam ${formatCountdown(remaining)}.`;
    };
    render();
    autoCloseTimer = setEverySecond(() => { remaining -= 1; render(); });
  };
  const showDialog = (hours, activeMs = 0) => {
    const copy = reminderCopy[hours];
    if (!copy) return;
    clearCountdownTimers();
    if (!open) returnFocus = documentRef.activeElement;
    open = true;
    dialog.dataset.thresholdHours = String(hours);
    image.src = copy.image;
    image.alt = copy.alt;
    title.textContent = copy.title;
    description.textContent = copy.body;
    eyebrow.textContent = `${formatActiveTime(activeMs)} aktif hari ini`;
    countdown.hidden = true;
    countdown.textContent = "";
    actions.replaceChildren();
    if (hours === 3) {
      const continueButton = button("Lanjutkan", "dismiss", true);
      actions.append(button("Tutup web", "close-website"), continueButton);
    } else if (hours === 5 || hours === 7) {
      const continueButton = button("Lanjutkan", "dismiss", true);
      actions.append(button("Tutup web", "close-website"), continueButton);
      startContinueCountdown(continueButton, hours === 5 ? 3 * 60 : 10 * 60);
    } else if (hours === 12) {
      actions.append(button("Tutup web", "close-website", true));
      startFinalCountdown();
    } else {
      actions.append(button("Tutup web", "close-website"), button("Lanjutkan", "dismiss", true));
    }
    overlay.hidden = false;
    if (hours === 5 || hours === 7) dialog.focus();
    else if (hours === 3) actions.querySelector('[data-screen-action="dismiss"]')?.focus();
    else actions.querySelector("button")?.focus();
  };
  const show = ({ thresholdHours, activeMs } = {}) => {
    if (thresholdHours === 3 || thresholdHours === 5 || thresholdHours === 7 || thresholdHours === 12) showDialog(thresholdHours, activeMs);
  };
  root.addEventListener("click", (event) => {
    const action = event.target.closest?.("[data-screen-action]")?.dataset.screenAction;
    if (action === "close-website") {
      void closeWebsite();
    } else if (action === "snooze") {
      tracker?.snooze(30);
      closeDialog();
    } else if (action === "dismiss") {
      tracker?.dismiss();
      closeDialog();
    }
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      const thresholdHours = Number(dialog.dataset.thresholdHours);
      if (thresholdHours === 3) {
        event.preventDefault();
        tracker?.dismiss();
        closeDialog();
      } else {
        event.preventDefault();
        actions.querySelector("button:not([disabled])")?.focus();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")];
    if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (documentRef.activeElement === first || documentRef.activeElement === dialog)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (documentRef.activeElement === last || documentRef.activeElement === dialog)) { event.preventDefault(); first.focus(); }
  });
  root.show = show;
  root.destroy = () => { clearCountdownTimers(); closeDialog(); root.remove(); };
  return root;
}
