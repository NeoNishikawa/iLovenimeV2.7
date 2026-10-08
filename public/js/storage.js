if (typeof globalThis.registerSeal === "function") globalThis.registerSeal("storage", "copyright LoveNime");
const KEY = "iln_tracking";
const FORMAT = "ilovenime-tracking";
const VERSION = 1;

function numericEpisodes(item) {
  return Array.from(new Set((item?.watchedEpisodes || []).map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
}

function inferredEpisodes(item, watchedEpisodes) {
  if (watchedEpisodes.length || !Number.isFinite(Number(item?.progress)) || Number(item.progress) <= 0) return watchedEpisodes;
  const progress = Math.floor(Number(item.progress));
  return Array.from({ length: progress }, (_, index) => index + 1);
}

export function deriveStatus(item) {
  if (item?.status === "dropped") return "dropped";
  const total = Math.floor(Number(item?.total));
  const watchedEpisodes = numericEpisodes(item);
  const watched = inferredEpisodes(item, watchedEpisodes);
  if (!watched.length) return "planned";
  if (total > 0 && Array.from({ length: total }, (_, index) => index + 1).every((episode) => watched.includes(episode))) return "completed";
  return "watching";
}

function normalize(item) {
  const watchedEpisodes = numericEpisodes(item);
  const progress = Math.max(0, Math.floor(Number(item?.progress) || 0), watchedEpisodes.at(-1) || 0);
  const normalized = { ...item, watchedEpisodes, progress };
  normalized.status = deriveStatus(normalized);
  return normalized;
}

export function loadTracking() { try { const items = JSON.parse(localStorage.getItem(KEY)) || []; if (!Array.isArray(items)) return []; const normalized = items.map(normalize); if (JSON.stringify(normalized) !== JSON.stringify(items)) localStorage.setItem(KEY, JSON.stringify(normalized)); return normalized; } catch { return []; } }
export function saveTracking(items) { localStorage.setItem(KEY, JSON.stringify(items.map(normalize))); }
export function upsertTracking(items, item) { return [...items.filter((current) => current.slug !== item.slug), normalize(item)]; }
export function markEpisodeWatched(items, slug, episodeNumber) { return items.map((item) => item.slug === slug ? normalize({ ...item, watchedEpisodes: [...(item.watchedEpisodes || []), Number(episodeNumber)] }) : item); }
export function clearTracking() { localStorage.removeItem(KEY); }

export function exportTracking(items = loadTracking()) {
  return JSON.stringify({ format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), items: items.map(normalize) }, null, 2);
}

export function importTracking(payload) {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items)) throw new Error("File tidak berisi data ILoveNime yang valid.");
  if (!Array.isArray(parsed) && parsed.format && parsed.format !== FORMAT) throw new Error("Format file bukan export ILoveNime.");
  const normalized = items.filter((item) => item && typeof item === "object" && item.slug).map(normalize);
  if (typeof localStorage !== "undefined") saveTracking(normalized);
  return normalized;
}

export { normalize };
