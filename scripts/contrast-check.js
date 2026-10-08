/* Hitung rasio kontras WCAG untuk pasangan warna yang benar-benar dipakai.
   Dipakai saat audit tombol/badge bernuansa kuning di light mode. */
function hexToRgb(hex) {
  const value = hex.replace("#", "").trim();
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const channel = v / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const cases = [
  ["nav-badge light (kuning di atas surface)", "#D97706", "#FFFFFF"],
  ["nav-badge light di atas gold-soft", "#D97706", "#FDF6E8"],
  ["gold-2 hover", "#F59E0B", "#FFFFFF"],
  ["fav-mark light (kuning di atas hitam 70%)", "#D97706", "#4D4D4D"],
  ["react-btn is-fav teks", "#FFD700", "#FFFFFF"],
  ["tab teks light (text-2 di atas surface)", "#64748B", "#FFFFFF"],
  ["tab teks light setelah override", "#0F172A", "#FFFFFF"],
  ["nav-item aktif light", "#FFFFFF", "#0891B2"],
  ["react-btn is-fav di light mode (sekarang)", "#FFD700", "#F1F3F5"],
];

for (const [label, fg, bg] of cases) {
  const ratio = contrast(fg, bg);
  const tag = ratio >= 4.5 ? "LULUS AA" : ratio >= 3 ? "AA besar saja" : "GAGAL";
  console.log(`${label.padEnd(46)} ${fg} di ${bg} = ${ratio.toFixed(2)}:1  ${tag}`);
}

console.log("\n== Kandidat warna untuk light mode (harus >= 4.5:1) ==");
const backgrounds = { "putih (#FFFFFF)": "#FFFFFF", "surface light (#F1F3F5)": "#F1F3F5", "gold-soft light (#FDF6E8)": "#FDF6E8", "hitam transparan 70% di atas putih (#4D4D4D)": "#4D4D4D" };
const candidates = ["#D97706", "#C2610A", "#B45309", "#A34D06", "#92400E", "#9A3412", "#B91C1C"];
for (const candidate of candidates) {
  const results = Object.entries(backgrounds).map(([name, bg]) => `${contrast(candidate, bg).toFixed(2)} di ${name.split(" ")[0]}`);
  const worst = Math.min(...Object.values(backgrounds).map((bg) => contrast(candidate, bg)));
  console.log(`  ${candidate}  ${results.join("  |  ")}   ${worst >= 4.5 ? "LULUS semua" : "belum semua"}`);
}