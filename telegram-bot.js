try { require('dotenv').config(); } catch(e) {} // opsional, tidak wajib ada
// telegram-bot.js — jalankan: node telegram-bot.js
// npm install node-fetch node-telegram-bot-api googleapis

const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const fs = require('fs');

// ── CONFIG ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';
const SERVICE_ACCOUNT_FILE = './service-account.json';

// ── Cek environment variables ─────────────────────────────────────────────
if (!process.env.TELEGRAM_TOKEN || !process.env.CEREBRAS_API_KEY) {
  console.error('❌ TELEGRAM_TOKEN dan CEREBRAS_API_KEY harus diset di .env!');
  process.exit(1);
}

// ── Google Auth ────────────────────────────────────────────────────────────
let sheetsClient = null;
let driveClient = null;

async function initGoogle() {
  let credentials = null;

  // Coba dari environment variable dulu (untuk Railway/cloud)
  if (process.env.SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
      console.log('✅ Service account loaded dari environment variable');
    } catch(e) {
      console.error('❌ SERVICE_ACCOUNT_JSON tidak valid JSON:', e.message);
      return false;
    }
  }
  // Fallback ke file lokal
  else if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    credentials = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8'));
    console.log('✅ Service account loaded dari file lokal');
  }
  else {
    console.log('⚠️  Service account tidak ditemukan! Set SERVICE_ACCOUNT_JSON di environment variable.');
    return false;
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly'
    ]
  });
  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  driveClient = google.drive({ version: 'v3', auth: authClient });
  console.log('✅ Google Auth berhasil');
  return true;
}

// ── Google Sheets ──────────────────────────────────────────────────────────
async function listSheets(folderId) {
  const res = await driveClient.files.list({
    q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: 50
  });
  return res.data.files || [];
}

// Ambil semua tab + header kolom tiap tab
async function getAllTabsWithHeaders(spreadsheetId) {
  const res = await sheetsClient.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties'
  });
  const tabTitles = res.data.sheets?.map(s => s.properties.title) || [];

  // Ambil header (baris pertama) tiap tab secara parallel
  const tabsWithHeaders = await Promise.all(
    tabTitles.map(async (title) => {
      try {
        const r = await sheetsClient.spreadsheets.values.get({
          spreadsheetId,
          range: title + '!1:1'
        });
        const headers = r.data.values?.[0] || [];
        return { title, headers };
      } catch(e) {
        return { title, headers: [] };
      }
    })
  );
  return tabsWithHeaders;
}

// Ambil data dari tab tertentu — skip baris kosong di awal
async function getTabData(spreadsheetId, tabName) {
  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: tabName,
      valueRenderOption: 'FORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    });
    const values = res.data.values || [];
    console.log(`getTabData ${tabName}: raw rows=${values.length}`);
    if (values.length === 0) return [];

    // Skip baris kosong di awal, cari baris yang punya BANYAK kolom berisi (itu header)
    let startRow = 0;
    let maxCols = 0;
    for (let i = 0; i < Math.min(values.length, 10); i++) {
      const row = values[i] || [];
      const filledCols = row.filter(cell => cell && cell.toString().trim() !== '').length;
      if (filledCols > maxCols) {
        maxCols = filledCols;
        startRow = i;
      }
    }
    console.log(`getTabData ${tabName}: startRow=${startRow}, maxCols=${maxCols}, total=${values.length - startRow}`);
    return values.slice(startRow);
  } catch(e) {
    console.log(`getTabData error for ${tabName}:`, e.message);
    return [];
  }
}

async function appendToSheet(spreadsheetId, tabName, values) {
  // Ganti placeholder tanggal dengan tanggal sebenarnya
  const today = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const cleanValues = values.map(v => {
    if (typeof v === 'string' && (v.includes('TODAY()') || v.toLowerCase().includes('hari ini') || v.toLowerCase() === 'today')) {
      return today;
    }
    if (v && typeof v === 'object' && v.function === 'TODAY()') return today;
    return v;
  });
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId,
    range: tabName,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [cleanValues] }
  });
}


// ── Write ke sel spesifik ─────────────────────────────────────────────────
async function updateCell(spreadsheetId, tabName, row, col, value) {
  const colLetter = String.fromCharCode(64 + col);
  const range = tabName + '!' + colLetter + row;
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId, range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] }
  });
}

async function writeRangeToTab(spreadsheetId, tabName, values) {
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId, range: tabName,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
}

// ── AI putuskan apakah perlu action (baca+tulis) atau hanya baca ──────────
async function decideAction(userMsg, sheets) {
  const sheetInfo = sheets.map(s => {
    const tabList = (s.tabsWithHeaders || []).map(t => {
      const cols = t.headers.length > 0 ? ` [kolom: ${t.headers.slice(0,8).join(', ')}]` : '';
      return `  - tab "${t.title}"${cols}`;
    }).join('\n');
    return `Sheet: "${s.name}" (id: ${s.id})\n${tabList}`;
  }).join('\n\n');

  const system = `Kamu asisten yang menganalisis permintaan user terhadap Google Sheets.

Daftar sheet, tab, dan kolom:
${sheetInfo}

Tentukan jenis aksi yang diperlukan dan balas HANYA dengan JSON:

Jika hanya MEMBACA data:
{"action":"fetch","targets":[{"id":"SHEET_ID","name":"SHEET_NAME","tab":"NAMA_TAB"}]}

Jika perlu MEMBACA lalu MENULIS hasil ke tab lain:
{"action":"compute","sources":[{"id":"SHEET_ID","name":"SHEET_NAME","tab":"NAMA_TAB"}],"destination":{"id":"SHEET_ID","name":"SHEET_NAME","tab":"NAMA_TAB"}}

Jika hanya MENULIS/INPUT data baru tanpa baca dulu:
{"action":"write","destination":{"id":"SHEET_ID","name":"SHEET_NAME","tab":"NAMA_TAB"},"values":[["val1","val2"]]}

Jika tidak perlu akses sheet sama sekali:
{"action":"skip"}`;

  const text = await callAI(system, [{ role: 'user', content: userMsg }], 500);
  try {
    const trimmed = text.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch(e) {}
  return { action: 'skip' };
}

// ── Helper: fetch data dari satu target ───────────────────────────────────
async function fetchTargetData(target, sheets) {
  const sheet = sheets.find(s => s.id === target.id)
    || sheets.find(s => s.name.toLowerCase().includes((target.name||'').toLowerCase()));
  if (!sheet) return null;

  const tabMatch = sheet.tabs.find(t => t.toLowerCase() === target.tab?.toLowerCase())
    || sheet.tabs.find(t => t.toLowerCase().includes((target.tab||'').toLowerCase()))
    || sheet.tabs[0];

  const rows = await getTabData(sheet.id, tabMatch);
  return { sheet, tabMatch, rows };
}

// ── AI hitung dan tentukan data yang mau ditulis ──────────────────────────
async function computeAndWrite(userMsg, sourcesData, destSheet, destTab) {
  let dataContext = '';
  for (const s of sourcesData) {
    if (!s || s.rows.length === 0) continue;
    const headers = s.rows[0];
    const dataRows = s.rows.slice(1);
    dataContext += `\n=== ${s.sheet.name} → Tab: ${s.tabMatch} (${dataRows.length} baris) ===\n`;
    dataContext += `Kolom: ${headers.join(' | ')}\n`;
    for (let i = 0; i < Math.min(dataRows.length, 100); i++) {
      const row = dataRows[i];
      const pairs = headers.map((h, ci) => `${h}: ${row[ci]||''}`).join(', ');
      dataContext += `${i+1}. ${pairs}\n`;
      if (dataContext.length > 10000) { dataContext += '...(dipotong)\n'; break; }
    }
  }

  const system = `Kamu asisten data analyst. User ingin kamu memproses data dari beberapa sumber dan menghasilkan data baru.

DATA SUMBER:
${dataContext}

TUJUAN PENULISAN: Sheet "${destSheet.name}" → Tab "${destTab}"

Tugas: Hitung/proses sesuai permintaan user, lalu balas HANYA dengan JSON berisi data yang akan ditulis:
{"result_description":"penjelasan singkat apa yang dihitung","rows":[["header1","header2"],["nilai1","nilai2"]]}

Pastikan rows berisi array of arrays. Baris pertama adalah header (jika perlu), sisanya adalah data.`;

  const text = await callAI(system, [{ role: 'user', content: userMsg }], 1000);
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch(e) {}
  return null;
}

// ── Cerebras AI ────────────────────────────────────────────────────────────────
async function callAI(system, messages, maxTokens = 800) {
  const fetch = (await import('node-fetch')).default;
  const allMessages = [];
  if (system) allMessages.push({ role: 'system', content: system });
  allMessages.push(...messages);

  const res = await fetch(CEREBRAS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CEREBRAS_API_KEY}`
    },
    body: JSON.stringify({
      model: 'zai-glm-4.7',
      messages: allMessages,
      max_tokens: maxTokens,
      temperature: 0.7
    })
  });
  const status = res.status;
  const rawText = await res.text();
  console.log('[CEREBRAS] Status:', status);
  console.log('[CEREBRAS] Response:', rawText.slice(0, 500));
  
  let data;
  try { data = JSON.parse(rawText); } 
  catch(e) { throw new Error('[CEREBRAS] Bukan JSON: ' + rawText.slice(0, 100)); }
  
  if (data.error) throw new Error('[CEREBRAS] Error: ' + (data.error.message || JSON.stringify(data.error)));
  
  // zai-glm-4.7 kadang taruh konten di message.content atau message.reasoning
  const choice = data.choices?.[0];
  const text = choice?.message?.content 
    || choice?.message?.reasoning
    || choice?.text
    || '';
  
  // Kalau ada reasoning tapi content kosong, ambil dari reasoning
  const reasoning = choice?.message?.reasoning || '';
  const finalText = text || reasoning;
  
  if (!finalText) throw new Error('Respons kosong dari AI.');
  return finalText;
}

// AI pilih: sheet mana + tab mana yang relevan
async function decideTarget(userMsg, sheets) {
  // Buat daftar lengkap: sheet + tab + kolom tiap tab
  const sheetInfo = sheets.map(s => {
    const tabList = (s.tabsWithHeaders || []).map(t => {
      const cols = t.headers.length > 0 ? ` [kolom: ${t.headers.slice(0,8).join(', ')}]` : '';
      return `  - tab "${t.title}"${cols}`;
    }).join('\n');
    return `Sheet: "${s.name}" (id: ${s.id})\n${tabList}`;
  }).join('\n\n');

  const system = `Tentukan sheet dan tab mana yang paling relevan untuk menjawab pertanyaan user.

Daftar sheet, tab, dan kolom yang tersedia:
${sheetInfo}

Pilih tab yang kolomnya paling relevan dengan pertanyaan user.
Jika perlu data, balas HANYA JSON (tanpa teks lain):
{"action":"fetch","targets":[{"id":"SHEET_ID","name":"SHEET_NAME","tab":"NAMA_TAB"}]}

Boleh lebih dari 1 target jika perlu.
Jika tidak perlu data sheet, balas HANYA: {"action":"skip"}`;

  const text = await callAI(system, [{ role: 'user', content: userMsg }], 400);
  try {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  } catch(e) {}
  return { action: 'skip' };
}

// ── Sessions ───────────────────────────────────────────────────────────────
const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { sheets: [] };
  return sessions[chatId];
}

// ── Telegram Bot ───────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'kamu';
  bot.sendMessage(msg.chat.id,
    `Halo ${name}! 👋 Saya *Sheets AI Bot*.\n\n` +
    `Saya bisa menganalisis data dari semua tab di Google Sheets kamu.\n\n` +
    `Perintah:\n` +
    `/folder <link> — Set folder Google Drive\n` +
    `/sheets — Lihat daftar sheets & tab\n` +
    `/help — Bantuan\n\n` +
    `Tanya apa saja dan saya akan otomatis cari tab yang relevan!`,
    
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `Cara pakai:\n\n` +
    `1. /folder <link Drive>\n` +
    `2. Tanya bebas:\n` +
    `   • "Data di tab ORDER NEW SALES"\n` +
    `   • "Rekap order bulan ini"\n` +
    `   • "Tampilkan report AM"\n` +
    `   • "Berapa total di tab TELDA?"\n\n` +
    `3. Input data:\n` +
    `   /input NamaSheet | NamaTab | val1 | val2 | ...`,
    
  );
});

bot.onText(/\/folder (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim();
  const m = input.match(/folders\/([a-zA-Z0-9_-]+)/);
  const folderId = m ? m[1] : (/^[a-zA-Z0-9_-]{25,}$/.test(input) ? input : null);
  if (!folderId) return bot.sendMessage(chatId, '❌ Link folder tidak valid.');

  bot.sendMessage(chatId, '🔍 Scanning sheets & tabs...');
  try {
    const files = await listSheets(folderId);
    if (!files.length) return bot.sendMessage(chatId, '⚠️ Tidak ada Google Sheets di folder ini.\nPastikan folder sudah di-share ke service account.');

    // Load semua tab + header secara parallel
    const sheets = await Promise.all(
      files.map(async (f) => {
        const tabsWithHeaders = await getAllTabsWithHeaders(f.id);
        const tabNames = tabsWithHeaders.map(t => t.title);
        console.log("Sheet:", f.name, "=> tabs:", tabNames);
        return { id: f.id, name: f.name, tabs: tabNames, tabsWithHeaders };
      })
    );

    const session = getSession(chatId);
    session.sheets = sheets;

    // Tampilkan daftar sheet + tab
    let msg2 = `✅ *${sheets.length} sheet ditemukan:*\n\n`;
    sheets.forEach((s, i) => {
      msg2 += `*${i+1}. ${s.name}*\n`;
      msg2 += `   Tab: ${s.tabs.join(', ')}\n\n`;
    });
    msg2 += `Sekarang tanya apa saja!`;
    bot.sendMessage(chatId, msg2);

  } catch(e) {
    bot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
});

bot.onText(/\/sheets/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (!session.sheets.length) return bot.sendMessage(chatId, 'Belum ada sheets. Gunakan /folder dulu.');

  let text = `*Daftar sheets & tabs:*\n\n`;
  session.sheets.forEach((s, i) => {
    text += `*${i+1}. ${s.name}*\n`;
    text += `   Tab: ${s.tabs.join(', ')}\n\n`;
  });
  bot.sendMessage(chatId, text);
});

bot.onText(/\/input (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  const parts = match[1].split('|').map(p => p.trim());

  if (parts.length < 3) return bot.sendMessage(chatId, 'Format: /input NamaSheet | NamaTab | nilai1 | nilai2 | ...');

  const sheetName = parts[0];
  const tabName = parts[1];
  const values = parts.slice(2);

  const sheet = session.sheets.find(s => s.name.toLowerCase().includes(sheetName.toLowerCase()));
  if (!sheet) return bot.sendMessage(chatId, `❌ Sheet "${sheetName}" tidak ditemukan.`);

  const tabMatch = sheet.tabs.find(t => t.toLowerCase().includes(tabName.toLowerCase()));
  if (!tabMatch) return bot.sendMessage(chatId, `❌ Tab "${tabName}" tidak ditemukan di sheet "${sheet.name}".\nTab tersedia: ${sheet.tabs.join(', ')}`);

  try {
    await appendToSheet(sheet.id, tabMatch, values);
    bot.sendMessage(chatId, `✅ Data berhasil ditambahkan ke ${sheet.name} → tab ${tabMatch}!`);
  } catch(e) {
    bot.sendMessage(chatId, `❌ Gagal: ${e.message}`);
  }
});

// Pesan biasa → AI
bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;
  const chatId = msg.chat.id;
  const userMsg = msg.text;
  if (!userMsg) return;

  const session = getSession(chatId);
  bot.sendChatAction(chatId, 'typing');

  try {
    if (!session.sheets.length) {
      const answer = await callAI('Kamu asisten Google Sheets. Jawab dalam bahasa Indonesia. Minta user set folder dulu dengan /folder', [{ role: 'user', content: userMsg }]);
      return bot.sendMessage(chatId, answer);
    }

    // AI putuskan jenis aksi
    const decision = await decideAction(userMsg, session.sheets);

    if (decision.action === 'skip') {
      // Cek apakah pertanyaan butuh data
      const dataKeywords = ['data','tampil','berapa','siapa','total','jumlah','cari','list','rekap','report','sales','order','pelanggan','terbanyak','terbaru','tertinggi','terendah','rata','penjualan','tabel','sheet','tab'];
      const needsData = dataKeywords.some(k => userMsg.toLowerCase().includes(k));
      if (needsData && session.sheets.length > 0) {
        // Paksa ambil dari semua sheet
        decision.action = 'fetch';
        decision.targets = session.sheets.map(s => ({ id: s.id, name: s.name, tab: s.tabs[0] }));
      } else {
        const answer = await callAI('Kamu asisten data analyst. Jawab dalam bahasa Indonesia.', [{ role: 'user', content: userMsg }]);
        return bot.sendMessage(chatId, answer);
      }
    }

    bot.sendChatAction(chatId, 'typing');


    // ── AKSI: hanya baca data ─────────────────────────────────────────────
    if (decision.action === 'fetch') {
      bot.sendMessage(chatId, '🔍 Sedang mengambil data...');
      let dataContext = '';
      for (const target of (decision.targets || [])) {
        const result = await fetchTargetData(target, session.sheets);
        if (!result || result.rows.length === 0) continue;
        const { sheet, tabMatch, rows } = result;
        const headers = rows[0];
        const allDataRows = rows.slice(1);
        dataContext += `\n=== ${sheet.name} → Tab: ${tabMatch} (${allDataRows.length} baris) ===\n`;
        dataContext += `Kolom: ${headers.join(' | ')}\n`;
        for (let i = 0; i < allDataRows.length; i++) {
          const row = allDataRows[i];
          const pairs = headers.map((h, ci) => `${h}: ${row[ci]||''}`).join(', ');
          const line = `${i+1}. ${pairs}\n`;
          if (i >= 80 || dataContext.length + line.length > 8000) {
            dataContext += `...(${allDataRows.length - i} baris lagi tidak ditampilkan)\n`;
            break;
          }
          dataContext += line;
        }
      }
      if (!dataContext) return bot.sendMessage(chatId, '⚠️ Tidak bisa ambil data dari tab yang diminta.');
      const system = `Kamu asisten data analyst. Jawab berdasarkan data berikut dalam bahasa Indonesia. Jawab spesifik dan akurat sesuai data yang diberikan.\n\nDATA:\n${dataContext}`;
      const answer = await callAI(system, [{ role: 'user', content: userMsg }], 800);
      return bot.sendMessage(chatId, answer);
    }

    // ── AKSI: baca beberapa sumber lalu tulis ke tujuan ──────────────────
    if (decision.action === 'compute') {
      bot.sendMessage(chatId, '⚙️ Memproses data...');
      const sourcesData = await Promise.all(
        (decision.sources || []).map(s => fetchTargetData(s, session.sheets))
      );

      // Cari sheet & tab tujuan
      const destTarget = decision.destination;
      const destSheetObj = session.sheets.find(s => s.id === destTarget?.id)
        || session.sheets.find(s => s.name.toLowerCase().includes((destTarget?.name||'').toLowerCase()));
      if (!destSheetObj) return bot.sendMessage(chatId, '❌ Sheet tujuan tidak ditemukan.');

      const destTab = destSheetObj.tabs.find(t => t.toLowerCase() === destTarget?.tab?.toLowerCase())
        || destSheetObj.tabs.find(t => t.toLowerCase().includes((destTarget?.tab||'').toLowerCase()))
        || destSheetObj.tabs[0];

      bot.sendMessage(chatId, '🧮 Menghitung dan memproses data...');
      const computed = await computeAndWrite(userMsg, sourcesData, destSheetObj, destTab);
      if (!computed || !computed.rows) return bot.sendMessage(chatId, '❌ Gagal menghitung data.');

      await writeRangeToTab(destSheetObj.id, destTab, computed.rows);
      bot.sendMessage(chatId, `✅ Selesai! ${computed.result_description}\n\nData ditulis ke: ${destSheetObj.name} → Tab: ${destTab}`);
      return;
    }

    // ── AKSI: tulis langsung ──────────────────────────────────────────────
    if (decision.action === 'write') {
      bot.sendMessage(chatId, '✏️ Menyimpan data...');
      const destTarget = decision.destination;
      const destSheetObj = session.sheets.find(s => s.id === destTarget?.id)
        || session.sheets.find(s => s.name.toLowerCase().includes((destTarget?.name||'').toLowerCase()));
      if (!destSheetObj) return bot.sendMessage(chatId, '❌ Sheet tujuan tidak ditemukan.');
      const destTab = destSheetObj.tabs.find(t => t.toLowerCase().includes((destTarget?.tab||'').toLowerCase())) || destSheetObj.tabs[0];
      const today2 = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const cleanVals = (decision.values || []).map(row =>
        (Array.isArray(row) ? row : [row]).map(v => {
          if (v && typeof v === 'object' && v.function) return today2;
          if (typeof v === 'string' && v.includes('TODAY()')) return today2;
          return v || '';
        })
      );
      await writeRangeToTab(destSheetObj.id, destTab, cleanVals);
      bot.sendMessage(chatId, `✅ Data berhasil ditulis ke ${destSheetObj.name} → Tab: ${destTab}`);
      return;
    }

  } catch(e) {
    bot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
});

initGoogle().then(ok => {
  if (ok) console.log('✅ Sheets AI Bot aktif! Cek Telegram kamu.');
  else console.log('⚠️  Bot aktif tapi Google belum terhubung. Taruh service-account.json dulu.');
});

console.log('🤖 Bot starting...');