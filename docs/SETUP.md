# Panduan teknis Amirah

[Kembali ke ringkasan produk](../README.md)

## Bot Telegram

Entry point yang dikonfigurasi pada `package.json` adalah `telegram-bot.js`.

1. Siapkan Node.js dan npm.
2. Jalankan `npm install` dari direktori repo.
3. Sediakan konfigurasi berikut pada lingkungan lokal atau hosting:

| Konfigurasi | Kegunaan |
| --- | --- |
| `TELEGRAM_TOKEN` | Token bot Telegram. |
| `CEREBRAS_API_KEY` | Kunci API untuk pemrosesan AI bot. |
| `SERVICE_ACCOUNT_JSON` | JSON service account Google pada environment hosting. |
| `service-account.json` | Alternatif file kredensial lokal jika `SERVICE_ACCOUNT_JSON` tidak digunakan. |

4. Siapkan akses Google Sheets API dan Google Drive API. Akun layanan harus memiliki akses ke folder/spreadsheet yang ingin digunakan; penulisan memerlukan hak edit.
5. Jalankan `npm start`.
6. Buka bot di Telegram, kirim `/start`, kemudian `/folder <tautan-folder>`.

Gunakan bot dan spreadsheet terpisah untuk demonstrasi. Simpan nilai kredensial di lingkungan lokal/hosting; `.gitignore` sudah mengecualikan `.env` dan `service-account.json`.

## Antarmuka web dalam repo

`index.html` dan `server.js` merupakan jalur web yang berbeda dari bot Telegram:

- Server web membaca `GROQ_API_KEY` dan menyediakan endpoint `POST /api/chat`.
- Server memakai Express dan CORS; keduanya belum tercantum dalam dependensi `package.json` saat dokumentasi ini disusun.
- Autentikasi Google pada web memerlukan konfigurasi OAuth yang sesuai dengan lingkungan pemakaian.

Karena itu, `npm start` menjalankan bot Telegram, bukan server web.

## Struktur integrasi

Bot memakai Google Drive untuk menemukan spreadsheet, Google Sheets untuk operasi data, dan Cerebras untuk pemrosesan bahasa. Sesi spreadsheet disimpan dalam memori proses bot.
