const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { detailErrorStatus } = require(path.join(ROOT, "server.js"));
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

test("404 dari upstream berarti judul tidak ada, bukan sumber mati", () => {
  assert.equal(detailErrorStatus({ notFound: true }), 404);
});

test("sisanya tetap 502: sumber mati, diblokir, atau tak terbaca", () => {
  assert.equal(detailErrorStatus(new Error("animasu HTTP 500")), 502);
  assert.equal(detailErrorStatus({ sourceBlocked: true }), 502);
  assert.equal(detailErrorStatus(new Error("timeout")), 502);
  assert.equal(detailErrorStatus(null), 502);
  assert.equal(detailErrorStatus(undefined), 502);
});

test("penanda notFound dipasang saat upstream membalas 404", () => {
  assert.match(serverSource, /error\.notFound = result\.status === 404;/);
  /* Jalur yang sering dipakai: error fetch sendiri (fetch menolak status
     di luar validateStatus) - penandanya harus dipasang di catch. */
  assert.match(serverSource, /const status = error\?\.response\?\.status;[\s\S]{0,700}?if \(status === 404\) error\.notFound = true;/);
});

test("route detail dan route streams memakai pemetaan status itu", () => {
  assert.match(serverSource, /const kode = detailErrorStatus\(error\);[\s\S]{0,220}?Anime ini tidak ditemukan di source\./);
  assert.match(serverSource, /const kode = detailErrorStatus\(error\);[\s\S]{0,200}?Mirror untuk episode ini tidak ditemukan\./);
});

test("klien tidak mengulang 404 (bukan retryable), jadi anime yang tidak ada tidak membanjiri upstream", () => {
  const api = fs.readFileSync(path.join(ROOT, "public/js/api.js"), "utf8");
  const baris = api.match(/function retryableStatus\(status\)\s*\{[^\n]*/);
  assert.ok(baris, "retryableStatus harus ada");
  assert.ok(!baris[0].includes("404"), "404 tidak boleh retryable");
  assert.ok(baris[0].includes("502"), "502 tetap retryable");
});
