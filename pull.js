const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const questions = require('./lib/questions.json');
const { scoreAnswers } = require('./lib/simulation');

// ==========================================
// KONFIGURASI
// ==========================================

const CONFIG = {
  spreadsheetId: '1xwzWS9qeEK5s97zM52cSV-n6McxqU-JuarxUJHHAVFU',
  gid: '1998052995',
  outputDir: './output',
  profileDir: './.browser-profile'
};

const SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${CONFIG.spreadsheetId}/edit#gid=${CONFIG.gid}`;

const CSV_URL =
  `https://docs.google.com/spreadsheets/d/${CONFIG.spreadsheetId}` +
  `/export?format=csv&gid=${CONFIG.gid}`;

// ==========================================
// CSV PARSER
// ==========================================

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }

      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(cells => cells.some(cell => cell.trim() !== ''));
}

const normalize = text =>
  String(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\*+$/, '')
    .trim();

function escapeCSV(value) {
  const text = String(value ?? '');

  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file, headers, rows) {
  const csv = [
    headers.map(escapeCSV).join(','),
    ...rows.map(row => row.map(escapeCSV).join(','))
  ].join('\n');

  fs.writeFileSync(file, '\uFEFF' + csv, 'utf8');
}

// ==========================================
// SESI BROWSER (login Google sekali)
// ==========================================

async function withSession(headless, handler) {
  const context = await chromium.launchPersistentContext(CONFIG.profileDir, {
    headless,
    locale: 'id-ID',
    viewport: { width: 1400, height: 900 }
  });

  try {
    return await handler(context);
  } finally {
    await context.close();
  }
}

async function login() {
  console.log('Membuka Google Spreadsheet. Login dengan akun pemilik sheet.');
  console.log('Setelah data sheet terlihat, tekan ENTER di terminal ini.');

  await withSession(false, async context => {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(SHEET_URL, { waitUntil: 'domcontentloaded' });

    await new Promise(resolve => {
      process.stdin.resume();
      process.stdin.once('data', resolve);
    });
  });

  console.log(`Sesi disimpan di ${CONFIG.profileDir}`);
}

async function exportCsv() {
  return withSession(true, async context => {
    const page = context.pages()[0] || (await context.newPage());
    const response = await page.goto(CSV_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const status = response ? response.status() : 0;

    if (status !== 200) {
      throw new Error(
        `Export gagal (HTTP ${status}). Jalankan "node pull.js --login" lebih dulu.`
      );
    }

    return page.evaluate(() => document.body.innerText);
  });
}

// ==========================================
// PROSES DATA
// ==========================================

function processSheet(text) {
  const rows = parseCsv(text);

  if (rows.length < 2) {
    throw new Error('Sheet belum berisi respons.');
  }

  const [headers, ...dataRows] = rows;

  // Judul item 13 dan 17 identik, jadi pemetaan memakai urutan kemunculan:
  // setiap judul mengambil pertanyaan berikutnya yang belum terpakai.
  const queues = new Map();

  for (const question of questions) {
    const key = normalize(question.title);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(question);
  }

  const columns = headers.map((header, index) => {
    const queue = queues.get(normalize(header));

    return { question: queue && queue.length ? queue.shift() : null, index };
  });

  const scaleColumns = columns.filter(
    column => column.question && column.question.dimension
  );

  if (!scaleColumns.length) {
    throw new Error('Kolom item skala tidak ditemukan. Cek urutan kolom sheet.');
  }

  const indexOf = formIndex => {
    const column = columns.find(entry => entry.question && entry.question.formIndex === formIndex);

    return column ? column.index : -1;
  };
  const records = [];

  for (const cells of dataRows) {
    const answers = {};

    for (const column of scaleColumns) {
      answers[column.question.entry] = String(cells[column.index] || '').trim();
    }

    if (scaleColumns.some(column => !answers[column.question.entry])) continue;

    records.push({
      timestamp: String(cells[0] || '').trim(),
      nama: String(cells[indexOf(2)] || '').trim(),
      usia: String(cells[indexOf(3)] || '').trim(),
      domisili: String(cells[indexOf(5)] || '').trim(),
      answers,
      scores: scoreAnswers(answers)
    });
  }

  if (!records.length) {
    throw new Error('Tidak ada baris dengan jawaban lengkap.');
  }

  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  writeCsv(
    path.join(CONFIG.outputDir, 'sheet_responses.csv'),
    [
      'no',
      'timestamp',
      'nama',
      'usia',
      'domisili',
      ...scaleColumns.map(column => `item_${column.question.formIndex}`)
    ],
    records.map((record, index) => [
      index + 1,
      record.timestamp,
      record.nama,
      record.usia,
      record.domisili,
      ...scaleColumns.map(column => record.answers[column.question.entry])
    ])
  );

  const dimensionKeys = records[0].scores.dimensions.map(item => item.key);

  writeCsv(
    path.join(CONFIG.outputDir, 'sheet_scores.csv'),
    [
      'no',
      'timestamp',
      'nama',
      ...dimensionKeys.map(key => `${key}_mean`),
      ...dimensionKeys.map(key => `${key}_kategori`),
      'grc_mean',
      'grc_kategori',
      'help_seeking_mean',
      'help_seeking_kategori',
      'burnout_mean',
      'burnout_kategori'
    ],
    records.map((record, index) => {
      const dimensions = Object.fromEntries(record.scores.dimensions.map(d => [d.key, d]));
      const scales = Object.fromEntries(record.scores.scales.map(s => [s.key, s]));

      return [
        index + 1,
        record.timestamp,
        record.nama,
        ...dimensionKeys.map(key => dimensions[key].mean),
        ...dimensionKeys.map(key => dimensions[key].category),
        scales.grc.mean,
        scales.grc.category,
        scales.help.mean,
        scales.help.category,
        scales.burnout.mean,
        scales.burnout.category
      ];
    })
  );

  console.log('================================');
  console.log('DATA DARI SPREADSHEET');
  console.log('================================');
  console.log(`Respons terbaca : ${records.length}`);
  console.log(`Item skala      : ${scaleColumns.length}`);
  console.log('');
  console.log('NO   WAKTU                  GRC    HELP   BURNOUT');
  console.log('-'.repeat(62));

  for (const [index, record] of records.entries()) {
    const scales = Object.fromEntries(record.scores.scales.map(s => [s.key, s]));

    console.log(
      String(index + 1).padEnd(5) +
        record.timestamp.slice(0, 20).padEnd(22) +
        String(scales.grc.mean).padEnd(7) +
        String(scales.help.mean).padEnd(7) +
        String(scales.burnout.mean)
    );
  }

  console.log('-'.repeat(62));
  console.log(`Output: ${CONFIG.outputDir}\\sheet_responses.csv, sheet_scores.csv`);
}

async function main() {
  const fileArg = process.argv.find(arg => arg.startsWith('--file='));

  if (process.argv.includes('--login')) {
    await login();
    return;
  }

  // --file=path: proses CSV lokal (mis. hasil "File > Download > CSV").
  const text = fileArg
    ? fs.readFileSync(fileArg.slice(7), 'utf8')
    : await exportCsv();

  processSheet(text);
}

main().catch(error => {
  console.error('GAGAL:', error.message);
  process.exit(1);
});
