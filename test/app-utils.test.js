const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let utils;
test.before(async () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/js/app-utils.js"), "utf8");
  utils = await import(`data:text/javascript,${encodeURIComponent(source)}`);
});

/* ---------- Paging 6×3 / 3×3 ---------- */
test("pageSize: 18 di desktop (6x3) dan 9 di mobile (3x3)", () => {
  assert.equal(utils.pageSizeFor(false), 18);
  assert.equal(utils.pageSizeFor(true), 9);
});

test("pageSlice membagi halaman dengan benar dan aman terhadap page di luar jangkauan", () => {
  const items = Array.from({ length: 43 }, (_, i) => i);
  assert.equal(utils.pageSlice(items, 0, 18).length, 18);
  assert.equal(utils.pageSlice(items, 2, 18).length, 7);
  assert.deepEqual(utils.pageSlice(items, 99, 18), [36, 37, 38, 39, 40, 41, 42]); /* di-clamp ke halaman terakhir */
  assert.equal(utils.pageCountFor(43, 18), 3);
  assert.equal(utils.pageCountFor(18, 18), 1);
  assert.equal(utils.pageCountFor(0, 18), 1);
});

/* ---------- Tamat / isComplete ---------- */
test("isComplete: status completed terhitung meski total tidak diketahui", () => {
  assert.equal(utils.isItemComplete({ status: "completed", total: 0, progress: 3 }), true);
  assert.equal(utils.isItemComplete({ total: 12, progress: 12 }), true);
  assert.equal(utils.isItemComplete({ total: 12, progress: 11 }), false);
  assert.equal(utils.isItemComplete({ total: 0, progress: 0, status: "watching" }), false);
  assert.equal(utils.isItemComplete({ total: 10, watchedEpisodes: [1, 2, 3] }), false);
});

/* ---------- Avatar guard ---------- */
test("avatar hanya menerima PNG, WebP, dan GIF", () => {
  assert.equal(utils.isAllowedAvatarFile({ type: "image/png", name: "a.png" }), true);
  assert.equal(utils.isAllowedAvatarFile({ type: "image/webp", name: "a.webp" }), true);
  assert.equal(utils.isAllowedAvatarFile({ type: "image/gif", name: "a.gif" }), true);
  assert.equal(utils.isAllowedAvatarFile({ type: "image/jpeg", name: "foto.jpg" }), false);
  assert.equal(utils.isAllowedAvatarFile({ type: "image/jpeg", name: "foto.jpeg" }), false);
  assert.equal(utils.isAllowedAvatarFile({ type: "video/mp4", name: "klip.mp4" }), false);
  assert.equal(utils.isAllowedAvatarFile({ type: "", name: "tanpa-ekstensi" }), false);
  assert.equal(utils.isAllowedAvatarFile(null), false);
  /* Ekstensi benar tapi MIME aneh tetap diterima (beberapa OS salah set MIME) */
  assert.equal(utils.isAllowedAvatarFile({ type: "", name: "avatar.GIF" }), true);
});

/* ---------- Export / Import v2 ---------- */
test("export v2 menyertakan profil dan items", () => {
  const payload = utils.buildExportPayload(
    [{ slug: "demo", title: "Demo", total: 12, progress: 4 }],
    { username: "Tiann", handle: "Local profile", avatarUrl: "data:image/gif;base64,R0=", theme: "dark", sidebarCollapsed: true }
  );
  assert.equal(payload.format, "ilovenime-tracking");
  assert.equal(payload.version, 2);
  assert.equal(payload.profile.username, "Tiann");
  assert.equal(payload.profile.sidebarCollapsed, true);
  assert.equal(payload.items[0].slug, "demo");
});

test("import: profil v2 dipulihkan, v1 tidak mengubah apa pun, URL asing ditolak", () => {
  const prefs = { username: "Lama", avatarUrl: "", theme: "dark" };
  const merged = utils.mergeImportedProfile({ profile: { username: "Baru", avatarUrl: "data:image/png;base64,AA==", theme: "light", sidebarCollapsed: false } }, prefs);
  assert.equal(merged.username, "Baru");
  assert.equal(merged.avatarUrl, "data:image/png;base64,AA==");
  assert.equal(merged.theme, "light");
  /* v1 tanpa profile: prefs utuh */
  const untouched = utils.mergeImportedProfile({ items: [] }, prefs);
  assert.equal(untouched.username, "Lama");
  /* avatarUrl berbahaya (bukan data:image) ditolak */
  const safe = utils.mergeImportedProfile({ profile: { avatarUrl: "https://evil.example/x.png", username: "Hacked" } }, prefs);
  assert.equal(safe.avatarUrl, "");
  assert.equal(safe.username, "Hacked"); /* nama tetap boleh, URL tidak */
});

test("Lanjutkan Menonton: hanya anime yang sudah ditonton minimal 1 episode", () => {
  const items = [
    { slug: "belum", progress: 0, watchedEpisodes: [], total: 12, status: "planned" },
    { slug: "satu", progress: 1, watchedEpisodes: [1], total: 12, status: "watching" },
    { slug: "tamat", progress: 12, watchedEpisodes: [1, 2, 3], total: 12, status: "completed" },
  ];
  const got = utils.continueCandidates(items).map((i) => i.slug);
  assert.deepEqual(got, ["satu"]);
});

test("Lanjutkan Menonton: item tanpa total tetap lolos untuk diverifikasi lewat detail", () => {
  const got = utils.continueCandidates([{ slug: "unknown", progress: 2, watchedEpisodes: [1, 2], total: 0 }]);
  assert.equal(got.length, 1);
  assert.equal(got[0].slug, "unknown");
});

test("Lanjutkan Menonton: urutan memakai lastWatchedAt, item lama fallback ke progres", () => {
  const items = [
    { slug: "lama", progress: 1, watchedEpisodes: [1], total: 10 },
    { slug: "baru", progress: 2, watchedEpisodes: [1, 2], total: 10, lastWatchedAt: 5000 },
    { slug: "tengah", progress: 2, watchedEpisodes: [1, 2], total: 10, lastWatchedAt: 3000 },
  ];
  assert.deepEqual(utils.continueCandidates(items).map((i) => i.slug), ["baru", "tengah", "lama"]);
});

test("Lanjutkan Menonton: limit membatasi jumlah kartu", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ slug: `a${i}`, progress: 1, watchedEpisodes: [1], total: 10, lastWatchedAt: i }));
  assert.equal(utils.continueCandidates(items, 8).length, 8);
});

test("Lanjutkan Menonton: nextUnwatched melompati episode yang sudah ditonton", () => {
  const episodes = [{ slug: "e1", number: 1 }, { slug: "e2", number: 2 }, { slug: "e3", number: 3 }];
  assert.equal(utils.nextUnwatched([], episodes).slug, "e1");
  assert.equal(utils.nextUnwatched([1], episodes).slug, "e2");
  assert.equal(utils.nextUnwatched([1, 2, 3], episodes), null);
  assert.equal(utils.nextUnwatched([99], episodes).slug, "e1");
});

test("Lanjutkan Menonton: episode tanpa slug dilewati, label dan sisa episode benar", () => {
  const episodes = [{ slug: "", number: 1 }, { slug: "e2", number: 2, title: "Mulai" }];
  assert.equal(utils.nextUnwatched([], episodes).slug, "e2");
  assert.match(utils.episodeLabel(episodes[1], "Judul"), /^Episode 2 · Mulai$/);
  assert.equal(utils.episodeLabel({ number: 7 }, "Judul"), "Episode 7");
  assert.equal(utils.remainingCount({ watchedEpisodes: [1, 2], total: 10 }, 10), 8);
  assert.equal(utils.remainingCount({ watchedEpisodes: [1], total: 0 }, 0), 0);
});
