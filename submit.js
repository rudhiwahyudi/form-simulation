const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const questions = require('./lib/questions.json');
const { buildRespondents, scoreAnswers } = require('./lib/simulation');
const store = require('./lib/store');

// ==========================================
// KONFIGURASI
// ==========================================

const CONFIG = {
  formUrl:
    'https://docs.google.com/forms/d/e/1FAIpQLSdjYJy4xzVl28dGCUzNAY2zIm9W4uoxO0bjs12GMjT2AyAZRA/viewform',

  totalRespondents: 10,

  // Jeda antar submit (ms). Google Forms mencatat waktu submit di server,
  // jadi jeda ini yang membuat jam tiap respons berbeda.
  delayBetweenMs: 60000,

  headless: true,
  dryRun: false,
  recapOnly: false,
  startIndex: 0,
  onlyIds: null,
  retries: 2,
  scheduled: false,
  scheduleEnd: '2026-11-25T23:59:00+07:00',
  outputDir: './output'
};

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === '--dry-run') CONFIG.dryRun = true;
    else if (arg === '--scheduled') CONFIG.scheduled = true;
    else if (arg === '--recap') CONFIG.recapOnly = true;
    else if (arg === '--headed') CONFIG.headless = false;
    else if (arg.startsWith('--delay=')) CONFIG.delayBetweenMs = Number(arg.slice(8));
    else if (arg.startsWith('--count=')) CONFIG.totalRespondents = Number(arg.slice(8));
    else if (arg.startsWith('--start=')) CONFIG.startIndex = Number(arg.slice(8));
    else if (arg.startsWith('--only=')) CONFIG.onlyIds = arg.slice(7).split(',');
    else if (arg.startsWith('--retries=')) CONFIG.retries = Number(arg.slice(10));
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const normalize = text =>
  String(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\*+$/, '')
    .trim();

const QUESTION_BY_TITLE = new Map(
  questions.map(question => [normalize(question.title), question])
);

function resolveQuestion(title) {
  const exact = QUESTION_BY_TITLE.get(title);

  if (exact) return exact;

  const prefix = title.slice(0, 45);

  return questions.find(question => normalize(question.title).startsWith(prefix));
}

// ==========================================
// CSV
// ==========================================

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

const SCALE_QUESTIONS = questions.filter(question => question.dimension);

function writeResponses(records) {
  const headers = [
    'respondent_id',
    'profil_jawaban',
    'nama',
    'usia',
    'status_pekerjaan',
    'domisili',
    'lama_bekerja',
    'submitted_at',
    ...SCALE_QUESTIONS.map(question => `item_${question.formIndex}`)
  ];

  const rows = records.map(record => [
    record.id,
    record.profile,
    record.demographics.nama,
    record.demographics.usia,
    record.demographics.statusPekerjaan,
    record.demographics.domisili,
    record.demographics.lamaBekerja,
    record.submittedAt || '',
    ...SCALE_QUESTIONS.map(question => record.answers[question.entry])
  ]);

  writeCsv(path.join(CONFIG.outputDir, 'responses.csv'), headers, rows);
}

function writeScores(records) {
  if (!records.length) return;

  const scored = records.map(record => ({ record, scores: scoreAnswers(record.answers) }));
  const dimensionKeys = scored[0].scores.dimensions.map(item => item.key);
  const headers = [
    'respondent_id',
    'profil_jawaban',
    ...dimensionKeys.map(key => `${key}_mean`),
    ...dimensionKeys.map(key => `${key}_kategori`),
    'grc_mean',
    'grc_kategori',
    'help_seeking_mean',
    'help_seeking_kategori',
    'burnout_mean',
    'burnout_kategori'
  ];

  const rows = scored.map(({ record, scores }) => {
    const dimensions = Object.fromEntries(
      scores.dimensions.map(item => [item.key, item])
    );
    const scales = Object.fromEntries(
      scores.scales.map(item => [item.key, item])
    );

    return [
      record.id,
      record.profile,
      ...dimensionKeys.map(key => dimensions[key].mean),
      ...dimensionKeys.map(key => dimensions[key].category),
      scales.grc.mean,
      scales.grc.category,
      scales.help.mean,
      scales.help.category,
      scales.burnout.mean,
      scales.burnout.category
    ];
  });

  writeCsv(path.join(CONFIG.outputDir, 'scores.csv'), headers, rows);
}

function printScoreTable(records) {
  if (!records.length) {
    console.log('\nBelum ada data terkirim.');
    return;
  }

  console.log('');
  console.log('SKOR SKALA (rata-rata 1.00 - 4.00)');
  console.log('-'.repeat(88));
  console.log(
    'ID'.padEnd(5) +
      'GRC'.padEnd(22) +
      'Help-Seeking'.padEnd(22) +
      'Burnout'.padEnd(22) +
      'Profil'
  );

  for (const record of records) {
    const scales = Object.fromEntries(
      scoreAnswers(record.answers).scales.map(item => [item.key, item])
    );

    console.log(
      record.id.padEnd(5) +
        `${scales.grc.mean} (${scales.grc.category})`.padEnd(22) +
        `${scales.help.mean} (${scales.help.category})`.padEnd(22) +
        `${scales.burnout.mean} (${scales.burnout.category})`.padEnd(22) +
        record.profile
    );
  }

  console.log('-'.repeat(88));
}

// ==========================================
// INTERAKSI GOOGLE FORM
// ==========================================

async function readListItems(page) {
  const items = page.locator('div[role="listitem"]');
  const count = await items.count();
  const result = [];

  for (let index = 0; index < count; index++) {
    const item = items.nth(index);
    const heading = item.locator('div[role="heading"]').first();
    const title = (await heading.count()) ? normalize(await heading.innerText()) : '';
    const hasInput =
      (await item.locator('div[role="radiogroup"]').count()) > 0 ||
      (await item.locator('input[type="text"], textarea').count()) > 0;

    // Listitem tanpa input adalah judul section / deskripsi.
    if (hasInput && title) {
      result.push({ item, title });
    }
  }

  return result;
}

function answerFor(question, respondent) {
  if (question.dimension) return respondent.answers[question.entry];

  const { demographics } = respondent;

  switch (question.formIndex) {
    case 0:
      return 'Ya';
    case 2:
      return demographics.nama;
    case 3:
      return String(demographics.usia);
    case 4:
      return demographics.statusPekerjaan;
    case 5:
      return demographics.domisili;
    case 6:
      return demographics.lamaBekerja;
    default:
      throw new Error(`Tidak ada jawaban untuk: ${question.title}`);
  }
}

async function fillPage(page, respondent) {
  const items = await readListItems(page);
  let filled = 0;

  for (const entry of items) {
    const question = resolveQuestion(entry.title);

    if (!question) {
      throw new Error(`Pertanyaan tidak dikenali: "${entry.title.slice(0, 70)}"`);
    }

    const value = answerFor(question, respondent);

    if (question.type === 'choice') {
      const radio = entry.item.getByRole('radio', { name: value, exact: true });
      await radio.waitFor({ state: 'visible', timeout: 15000 });
      await radio.click({ timeout: 15000 });

      // Google Forms kadang butuh satu tick untuk menandai aria-checked.
      for (let attempt = 0; attempt < 10; attempt++) {
        if ((await radio.getAttribute('aria-checked')) === 'true') break;
        await page.waitForTimeout(150);
      }

      if ((await radio.getAttribute('aria-checked')) !== 'true') {
        await radio.click({ force: true, timeout: 15000 });
        await page.waitForTimeout(300);

        if ((await radio.getAttribute('aria-checked')) !== 'true') {
          throw new Error(`Gagal memilih "${value}" pada "${question.title.slice(0, 50)}"`);
        }
      }
    } else {
      const input = entry.item.getByRole('textbox').first();
      await input.waitFor({ state: 'visible', timeout: 15000 });

      // Input baru aktif setelah section selesai dirender.
      for (let attempt = 0; attempt < 20; attempt++) {
        if (await input.isEnabled()) break;
        await page.waitForTimeout(250);
      }

      await input.fill(String(value), { timeout: 15000 });
      await input.evaluate(node => node.blur());
    }

    filled++;
  }

  return filled;
}

async function submitOne(browser, respondent) {
  const context = await browser.newContext({
    locale: 'id-ID',
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  try {
    await page.goto(CONFIG.formUrl, { waitUntil: 'networkidle', timeout: 90000 });
    await page.locator('div[role="listitem"]').first().waitFor({ state: 'visible', timeout: 20000 });

    for (let step = 1; step <= 12; step++) {
      const filled = await fillPage(page, respondent);
      console.log(`  halaman ${step}: ${filled} pertanyaan terisi`);

      const next = page.getByRole('button', { name: 'Berikutnya', exact: true });

      if ((await next.count()) === 0 || !(await next.first().isVisible())) break;

      await next.first().click();
      await page.waitForTimeout(600);
      await page.waitForLoadState('networkidle');
    }

    if (CONFIG.dryRun) {
      await page.screenshot({
        path: path.join(CONFIG.outputDir, `dryrun-${respondent.id}.png`),
        fullPage: true
      });

      return { status: 'DRY_RUN' };
    }

    const submit = page.getByRole('button', { name: 'Kirim', exact: true });
    await submit.first().click();
    await page.waitForTimeout(2500);

    const body = await page.locator('body').innerText();
    const recorded = /Jawaban Anda telah direkam|Your response has been recorded/i.test(body);

    if (!recorded) {
      await page.screenshot({
        path: path.join(CONFIG.outputDir, `gagal-${respondent.id}.png`),
        fullPage: true
      });

      throw new Error('Konfirmasi "Jawaban Anda telah direkam" tidak muncul');
    }

    return { status: 'BERHASIL', submittedAt: new Date().toISOString() };
  } finally {
    await context.close();
  }
}

function buildSchedule(count) {
  const now = Date.now();
  const end = new Date(CONFIG.scheduleEnd).getTime();
  const usableEnd = Math.max(now + 60 * 60 * 1000, end);
  const span = usableEnd - now;
  const schedule = [];

  for (let index = 0; index < count; index++) {
    if (index === 0) {
      schedule.push(now);
      continue;
    }

    if (index === count - 1) {
      schedule.push(usableEnd);
      continue;
    }

    const ideal = now + (span * index) / (count - 1);
    const jitter = (Math.random() - 0.5) * 45 * 60 * 1000;
    schedule.push(Math.round(Math.min(usableEnd - 60 * 1000, Math.max(now + 60 * 1000, ideal + jitter))));
  }

  schedule.sort((a, b) => a - b);

  for (let index = 1; index < schedule.length; index++) {
    const gap = schedule[index] - schedule[index - 1];
    if (gap < 60 * 60 * 1000) {
      schedule[index] = schedule[index - 1] + 60 * 60 * 1000;
    }
  }

  return schedule.map(timestamp => new Date(timestamp).toISOString());
}

// ==========================================
// MAIN
// ==========================================

async function main() {
  parseArgs(process.argv.slice(2));
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  // --recap: hitung ulang skor dari state.json tanpa membuka browser.
  if (CONFIG.recapOnly) {
    const records = store.submitted();

    if (!records.length) {
      console.log('Belum ada data terkirim di output/state.json.');
      return;
    }

    writeResponses(records);
    writeScores(records);
    printScoreTable(records);
    console.log(`\nRekap ulang: ${records.length} responden -> output/responses.csv, scores.csv`);

    return;
  }

  const allRespondents = buildRespondents(CONFIG.totalRespondents);
  const respondents = CONFIG.onlyIds
    ? allRespondents.filter(respondent => CONFIG.onlyIds.includes(respondent.id))
    : allRespondents.slice(CONFIG.startIndex);
  const schedule = CONFIG.scheduled ? buildSchedule(respondents.length) : null;

  console.log('================================');
  console.log(CONFIG.dryRun ? 'MODE DRY RUN - form diisi, TIDAK dikirim' : 'MODE SUBMIT KE GOOGLE FORM');
  console.log('================================');
  console.log(`Responden   : ${respondents.length}${CONFIG.onlyIds ? ` (${CONFIG.onlyIds.join(', ')})` : ` (mulai ${CONFIG.startIndex + 1})`}`);
  console.log(`Item skala  : ${SCALE_QUESTIONS.length}`);
  console.log(`Jeda submit : ${CONFIG.delayBetweenMs / 1000} detik`);
  if (schedule) {
    console.log('Jadwal target :');
    schedule.forEach((timestamp, index) => {
      console.log(`  ${index + 1}. ${timestamp}`);
    });
  }
  console.log('================================');

  const browser = await chromium.launch({ headless: CONFIG.headless });
  const log = [];

  try {
    for (const [index, respondent] of respondents.entries()) {
      console.log(`\n[${index + 1}/${respondents.length}] ${respondent.id} - ${respondent.profile}`);

      if (schedule && !CONFIG.dryRun) {
        const waitMs = new Date(schedule[index]).getTime() - Date.now();

        if (waitMs > 0) {
          console.log(`  menunggu jadwal ${schedule[index]} ...`);
          await sleep(waitMs);
        }
      }

      try {
        let result;

        for (let attempt = 1; attempt <= CONFIG.retries + 1; attempt++) {
          try {
            result = await submitOne(browser, respondent);
            break;
          } catch (error) {
            if (attempt > CONFIG.retries) throw error;
            console.log(`  percobaan ${attempt} gagal (${error.message.split('\n')[0]}), ulangi...`);
            await sleep(5000);
          }
        }

        respondent.submittedAt = result.submittedAt || '';
        respondent.status = result.status;
        log.push({ id: respondent.id, ...result });
        console.log(`  -> ${result.status}`);
      } catch (error) {
        respondent.status = 'GAGAL';
        log.push({ id: respondent.id, status: 'GAGAL', error: error.message });
        console.log(`  -> GAGAL: ${error.message.split('\n')[0]}`);
      }

      if (respondent.status !== 'DRY_RUN') {
        store.upsert(respondent);
        const records = store.submitted();
        writeResponses(records);
        writeScores(records);
      }

      const isLast = index === respondents.length - 1;

      if (!schedule && !isLast && CONFIG.delayBetweenMs > 0) {
        console.log(`  menunggu ${CONFIG.delayBetweenMs / 1000}s ...`);
        await sleep(CONFIG.delayBetweenMs);
      }
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(
    path.join(CONFIG.outputDir, 'submission_log.json'),
    JSON.stringify(log, null, 2),
    'utf8'
  );

  printScoreTable(store.submitted());

  const success = log.filter(entry => entry.status === 'BERHASIL').length;
  const failed = log.filter(entry => entry.status === 'GAGAL').length;
  const total = store.submitted().length;

  console.log('');
  console.log('================================');
  console.log(`Run ini  : ${success} berhasil, ${failed} gagal`);
  console.log(`Tersimpan: ${total} responden di output/state.json`);
  console.log(`Output   : ${CONFIG.outputDir}\\responses.csv, scores.csv, state.json`);
  console.log('================================');
}

main().catch(error => {
  console.error('FATAL:', error.message);
  process.exit(1);
});
