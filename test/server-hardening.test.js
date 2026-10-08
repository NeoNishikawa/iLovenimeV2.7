/* Regression test penguatan server (temuan fuzz 6 Oktober 2026, lihat .ciel/todo.md):
   1. URI persen cacat -> 400 rapi (JSON untuk /api, teks untuk non-API), tanpa stack trace.
   2. JSON body korup -> 400 JSON dari error handler global, bukan HTML default Express.
   3. Body JSON melebihi batas 100kb -> 413 JSON. */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { app } = require("../server.js");

function makeRequest(server, options) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    let settled = false;
    const req = http.request({ host: "127.0.0.1", port, ...options }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        settled = true;
        resolve({ status: res.statusCode, raw: data, json: (() => { try { return JSON.parse(data); } catch (_) { return null; } })() });
      });
    });
    /* Body raksasa bisa membuat server membalas 413 lalu menutup koneksi sebelum
       klien selesai menulis — error tulis setelah respons tidak boleh menggagalkan test. */
    req.on("error", (error) => { if (!settled) reject(error); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function withServer(run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(server); } finally { server.close(); }
}

test("Hardening: URI persen cacat dibalas 400 rapi, bukan HTML stack trace", async () => {
  await withServer(async (server) => {
    const api = await makeRequest(server, { path: "/api/anime/%ff", method: "GET" });
    assert.equal(api.status, 400);
    assert.ok(api.json && typeof api.json.error === "string", "path /api dibalas JSON dengan field error");
    const page = await makeRequest(server, { path: "/%zz", method: "GET" });
    assert.equal(page.status, 400);
    assert.ok(!page.raw.includes("    at "), "tanpa jejak stack");
    assert.ok(!page.raw.includes("node_modules"), "tanpa bocoran path internal");
  });
});

test("Hardening: JSON body korup dibalas 400 JSON, bukan HTML default Express", async () => {
  await withServer(async (server) => {
    const res = await makeRequest(server, { path: "/api/any-route", method: "POST", headers: { "Content-Type": "application/json" }, body: "{\"malformed\": tru" });
    assert.equal(res.status, 400);
    assert.ok(res.json && typeof res.json.error === "string");
    assert.ok(!res.raw.includes("SyntaxError"), "tanpa kebocoran nama error internal");
  });
});

test("Hardening: body JSON di atas batas 100kb dibalas 413 JSON", async () => {
  await withServer(async (server) => {
    const big = JSON.stringify({ pad: "x".repeat(120 * 1024) });
    const res = await makeRequest(server, { path: "/api/any-route", method: "POST", headers: { "Content-Type": "application/json" }, body: big });
    assert.equal(res.status, 413);
    assert.ok(res.json && typeof res.json.error === "string");
  });
});
