const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { app, normalizeSearchText, normalizeTitleKey, normalizeEpisodes, parseAnimeDetail, parseMirrorOptions, decodeMirror, splitAliases, uniqueBySlug, slices, extractSlug } = require("../server");

// Helper to send HTTP requests to test server
function makeRequest(server, options) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({ host: "127.0.0.1", port, ...options }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, raw: data, json });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("Robustness: normalizeSearchText handles abnormal, extreme, and malformed inputs without crashing", () => {
  const edgeCases = [
    null,
    undefined,
    "",
    "   ",
    12345,
    true,
    false,
    {},
    [],
    ["a", "b"],
    "\0\0\0",
    "A\u0300\u0301\u0302", // multiple combining accents
    "🔥⚔️👑", // pure emojis
    "日本語タイトル", // CJK characters (foreign-char-ok)
    "مرحبا بالعالم", // RTL Arabic (foreign-char-ok)
    "A".repeat(50000), // extreme length
    "   a   b   c   ".repeat(1000), // space explosion
    ".*+?^${}()|[]\\", // regex metacharacters
    "<script>alert('xss')</script>",
    "'; DROP TABLE anime; --",
  ];

  for (const input of edgeCases) {
    const start = Date.now();
    const result = normalizeSearchText(input);
    const elapsed = Date.now() - start;
    assert.equal(typeof result, "string", `Input ${typeof input} must return string`);
    assert.ok(elapsed < 100, `Execution for input must take < 100ms (took ${elapsed}ms)`);
  }
});

test("Robustness: ReDoS resistance for title and alias regex patterns", () => {
  // Test splitAliases with deeply nested repeating delimiters
  const evilDelimiters = ("|,".repeat(5000)) + "synonym: title";
  const startSplit = Date.now();
  const aliases = splitAliases(evilDelimiters);
  const elapsedSplit = Date.now() - startSplit;
  assert.ok(elapsedSplit < 50, `splitAliases took ${elapsedSplit}ms`);
  assert.ok(Array.isArray(aliases));

  // Test normalizeTitleKey with extreme repeating characters
  const evilTitle = "season ".repeat(500) + "1 ".repeat(500);
  const startTitle = Date.now();
  const normalizedKey = normalizeTitleKey(evilTitle);
  const elapsedTitle = Date.now() - startTitle;
  assert.ok(elapsedTitle < 50, `normalizeTitleKey took ${elapsedTitle}ms`);
  assert.equal(typeof normalizedKey, "string");
});

test("Robustness: normalizeEpisodes gracefully handles corrupt and malformed episode objects", () => {
  const corruptList = [
    null,
    undefined,
    {},
    { title: "No episode number" },
    { episode: "Episode -5", slug: "slug-negative" },
    { episode: "Episode 999999999999999999", slug: "slug-huge" },
    { episode: "Episode 1.5 Special", slug: "slug-float" },
    { episode: "Bukan angka sama sekali", slug: "slug-nan" },
    { episode: 12, slug: null },
    { episode: null, slug: "no-ep" },
  ];

  assert.doesNotThrow(() => {
    const normalized = normalizeEpisodes(corruptList);
    assert.ok(Array.isArray(normalized));
  });
});

test("Robustness: HTML parsers tolerate truncated, empty, and malformed HTML without throwing", () => {
  const malformedInputs = [
    "",
    "   ",
    "<<<<<>>>>>",
    "<div><p>Unclosed tags everywhere",
    "<select class='mirror'><option>No value or url</option></select>",
    "<div><h1>Only Title</h1></div>",
    "<script>null.throw()</script>",
    "A".repeat(20000),
  ];

  for (const html of malformedInputs) {
    assert.doesNotThrow(() => {
      const detail = parseAnimeDetail(html, "fallback-slug");
      assert.ok(detail && typeof detail === "object");
    });

    assert.doesNotThrow(() => {
      const mirrors = parseMirrorOptions(html);
      assert.ok(Array.isArray(mirrors));
    });
  }
});

test("Robustness: decodeMirror handles corrupt base64 and invalid data without uncaught errors", () => {
  const corruptBase64 = [
    "",
    "not-base-64!!",
    "====",
    Buffer.from("plaintext without iframe").toString("base64"),
    Buffer.from("<iframe src='javascript:void(0)'></iframe>").toString("base64"),
    Buffer.from("<iframe src=''></iframe>").toString("base64"),
  ];

  for (const input of corruptBase64) {
    assert.doesNotThrow(() => {
      decodeMirror(input);
    });
  }
});

test("Robustness: HTTP Endpoints handle type confusion, path traversal, and payload fuzzing", async () => {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    // 1. Type confusion on query parameters: search as array or object
    const arrayQuery = await makeRequest(server, { path: "/api/catalog?search[]=foo&search[]=bar", method: "GET" });
    assert.ok([200, 400, 429].includes(arrayQuery.status), `Array query must return valid status, got ${arrayQuery.status}`);

    // 2. Query string with special characters and null bytes
    const nullByteQuery = await makeRequest(server, { path: "/api/catalog?search=naruto%00test&genre=", method: "GET" });
    assert.ok([200, 400, 429].includes(nullByteQuery.status));

    // 3. Huge query string (5,000 characters)
    const longQuery = await makeRequest(server, { path: `/api/catalog?search=${"a".repeat(5000)}&genre=`, method: "GET" });
    assert.ok([200, 400, 414, 429].includes(longQuery.status));

    // 4. Path traversal attempt on /api/anime/:slug
    const traversal = await makeRequest(server, { path: "/api/anime/..%2f..%2fpackage.json", method: "GET" });
    assert.ok([400, 404, 502, 503].includes(traversal.status));

    // 5. Extremely long slug parameter
    const longSlug = await makeRequest(server, { path: `/api/anime/${"x".repeat(3000)}`, method: "GET" });
    assert.ok([400, 404, 414, 502, 503].includes(longSlug.status));

    // 6. Unknown /api routes return 404 JSON, not HTML or 500 crash
    const unknownRoute = await makeRequest(server, { path: "/api/some-random-invalid-endpoint-12345", method: "GET" });
    assert.equal(unknownRoute.status, 404);
    assert.ok(unknownRoute.json && unknownRoute.json.error);

    // 7. Malformed HTTP methods on API routes (POST to GET endpoint)
    const postToGet = await makeRequest(server, { path: "/api/catalog", method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    // Should be caught by 404 catch-all or handled
    assert.ok([404, 405].includes(postToGet.status));

    // 8. Malformed JSON payload on POST request
    const malformedJson = await makeRequest(server, { path: "/api/any-route", method: "POST", headers: { "Content-Type": "application/json" }, body: "{malformed json" });
    assert.ok([400, 404].includes(malformedJson.status));

  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* Fuzz Putaran 2 (6 Oktober) menemukan 45 throw di parser; jalur HTTP hari
   ini masih aman, tapi satu perubahan struktur upstream cukup untuk 500
   massal. Test ini mengunci perbaikan 8 Oktober: setiap kasus di bawah
   tadinya MELEMPAR (diverifikasi langsung sebelum guard ditulis), sekarang
   harus menjawab nilai kosong yang sah tanpa exception. */
test("Robustness: parser menerima input non-string/non-array tanpa melempar (regression Fuzz Putaran 2)", () => {
  // normalizeEpisodes: null (default param tidak menolong null) dan non-array
  assert.deepEqual(normalizeEpisodes(null), []);
  assert.deepEqual(normalizeEpisodes(undefined), []);
  assert.deepEqual(normalizeEpisodes("abc"), []);
  assert.deepEqual(normalizeEpisodes(42), []);
  assert.deepEqual(normalizeEpisodes({ length: 3, 0: { slug: "x" } }), []);

  // uniqueBySlug: null dan non-array
  assert.deepEqual(uniqueBySlug(null), []);
  assert.deepEqual(uniqueBySlug(undefined), []);
  assert.deepEqual(uniqueBySlug("abc"), []);
  assert.deepEqual(uniqueBySlug({ a: 1 }), []);

  // Parser HTML: cheerio melempar "Cannot create property 'prev'" untuk
  // input truthy bukan-string; angka, boolean, objek, dan Buffer sama-sama
  // harus dijawab struktur kosong yang sah
  for (const bukanHtml of [123, true, {}, Buffer.from("x"), () => {}]) {
    assert.doesNotThrow(() => parseAnimeDetail(bukanHtml, "fallback-slug"));
    assert.deepEqual(parseMirrorOptions(bukanHtml), []);
  }

  // Helper teks: objek tanpa primitive ({toString:null}) mematikan String()
  const tanpaPrimitif = { toString: null };
  assert.equal(normalizeSearchText(tanpaPrimitif), "");
  assert.equal(normalizeTitleKey(tanpaPrimitif), "");
  assert.deepEqual(splitAliases(tanpaPrimitif), []);
  assert.equal(decodeMirror(tanpaPrimitif), "");

  // splitAliases rekursif: elemen jelek di tengah array tidak boleh
  // merusak elemen yang sah
  assert.deepEqual(splitAliases(["Alpha", tanpaPrimitif, "Beta"]), ["Alpha", "Beta"]);

  // Perilaku normal TIDAK berubah
  assert.deepEqual(
    normalizeEpisodes([{ episode: "Episode 3", slug: "e3" }]).map((e) => e.number),
    [3]
  );
  assert.deepEqual(uniqueBySlug([{ slug: "one" }, { slug: "one" }, { slug: "two" }]).map((i) => i.slug), ["one", "two"]);
  // decodeMirror base64 hanya menghasilkan URL kalau isinya HTML iframe/
  // source/video; base64 teks polos memang sah dijawab ""
  assert.equal(decodeMirror(Buffer.from("<iframe src='https://mirror.example/one'></iframe>").toString("base64")), "https://mirror.example/one");
  assert.equal(decodeMirror(Buffer.from("plaintext without iframe").toString("base64")), "");
});

/* Fuzz Manas 8 Oktober: tipe hostile lanjutan (getter yang melempar,
   Symbol.toPrimitive jahat, Proxy yang throw saat get, BigInt, Symbol).
   Ketemu 7 crash baru — semuanya lewat extractSlug (String(value) di luar
   try) dan akses properti elemen di uniqueBySlug/normalizeEpisodes. */
test("Robustness: extractSlug dan akses properti elemen tahan objek ber-throw (regression fuzz Manas)", () => {
  const boom = () => { throw new Error("boom"); };
  const withThrowingToString = { toString: boom };
  const withThrowingToPrimitive = { [Symbol.toPrimitive]: boom };
  const throwingProxy = new Proxy({}, { get() { throw new Error("boom-prop"); } });

  // extractSlug: semua jalur harus string-masuk, tanpa exception
  assert.doesNotThrow(() => extractSlug(withThrowingToString));
  assert.doesNotThrow(() => extractSlug(withThrowingToPrimitive));
  assert.doesNotThrow(() => extractSlug(throwingProxy));
  assert.doesNotThrow(() => extractSlug(Symbol("x")));
  assert.equal(extractSlug("https://example.com/anime/abc/"), "abc"); // perilaku normal

  // uniqueBySlug: elemen ber-Proxy yang throw saat get DILEWATI
  assert.doesNotThrow(() => uniqueBySlug([throwingProxy, { slug: "a" }]));
  assert.deepEqual(uniqueBySlug([throwingProxy, { slug: "a" }]).map((i) => i.slug), ["a"]);

  // normalizeEpisodes: elemen ber-Proxy yang throw saat get DILEWATI
  assert.doesNotThrow(() => normalizeEpisodes([throwingProxy, { episode: "Episode 1", slug: "e1" }]));
  const hasil = normalizeEpisodes([throwingProxy, { episode: "Episode 1", slug: "e1" }]);
  assert.deepEqual(hasil.map((e) => e.slug), ["e1"]);
});
