# iLoveNime

> **Audit 13 Oktober 2026.** Dua koreksi:
>
> - **Versi aktif V2.7, bukan V2.5.** Aplikasi melaporkan dirinya sendiri
>   `iLoveNime V2.7` di `public/index.html:6` dan `:91`. Tulisan "its V2.5"
>   di bawah sudah usang.
> - **Ada 1 vulnerability CRITICAL.** `npm audit --omit=dev` melaporkan
>   `proxy-addr` GHSA-jqcg-44mw-7w3h (IP spoofing), exit code 1.
>   Hampir semua dokumen di repo ini menulis "0 vulnerability" — itu **salah**.
>   Ini perlu ditangani Neo lebih dulu.
>
> Catatan lain: repo ini **tidak bisa** menghasilkan installer Windows.
> `package.json:11` menunjuk `desktop/main.js` yang tidak ada, dan folder
> `desktop/` tidak pernah ada di sini. Yang benar-benar ada adalah konfigurasi
> electron-builder di kunci `build` (`package.json:40-81`) — sisa V1 — beserta
> devDependency `electron` dan `electron-builder` yang tidak terpakai.
> README di bawah hanya membahas alur unduh EXE, padahal repo ini repo web.
>
> Angka terverifikasi: `npm test` **194/194** (17 berkas test) ·
> segel `iln:945877755` (22 aset) · `server.js` 1.139 baris · port 3099.

its V2.5
ini adalah personal projek, mohon maaf jika terjadi bug

## Downloads

- **Windows .exe** - `iLoveNime-X1.7.2-Setup-x64.exe` (~96 MB, update otomatis)

## "Windows protected your PC" / "Unknown Publisher"

Saat pertama kali menjalankan installer Windows, peringatan biru SmartScreen
muncul. Itu **normal**, bukan tanda file rusak atau virus.

**Penyebabnya:** iLoveNime dibuat independen, jadi installer-nya belum
punya sertifikat digital resmi dari perusahaan penerbit (CA) seperti
Microsoft atau Symantec. Windows tidak mengenali penerbitnya, makanya
ditampilkan "Unknown Publisher".

**Cara membukanya:**

1. Klik **"More info"** (atau **"Show more"**) di kiri bawah jendela.
2. Klik **"Run anyway"**.

Setelah beberapa kali, peringatan ini tidak muncul lagi di komputer yang
sama.

**Penting:** tombol **"Run anyway"** hanya untuk file
`iLoveNime-X1.7.2-Setup-x64.exe` yang diunduh dari halaman resmi iLoveNime.
Jangan pernah menekan "Run anyway" pada nama file lain yang tidak kamu
Kenali.