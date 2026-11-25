const { chromium } = require('playwright');
const questions = require('./lib/questions.json');
const { buildRespondents } = require('./lib/simulation');

const FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSdjYJy4xzVl28dGCUzNAY2zIm9W4uoxO0bjs12GMjT2AyAZRA/viewform';

// Form ini terdiri dari 5 halaman. Mengirim semua entry sekaligus lewat
// /formResponse hanya menyimpan jawaban halaman pertama (persetujuan), jadi
// pengisian harus lewat browser seperti manusia: isi halaman, klik Berikutnya,
// lalu Kirim.
const MAX_PAGES = 12;

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

async function submit(respondentId, { dryRun = false } = {}) {
  const respondent = buildRespondents(10).find(item => item.id === respondentId);

  if (!respondent) throw new Error(`Respondent tidak valid: ${respondentId}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'id-ID',
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  const summary = {
    respondentId,
    name: respondent.demographics.nama,
    domisili: respondent.demographics.domisili
  };

  try {
    await page.goto(FORM_URL, { waitUntil: 'networkidle', timeout: 90000 });
    await page
      .locator('div[role="listitem"]')
      .first()
      .waitFor({ state: 'visible', timeout: 20000 });

    let filledTotal = 0;

    for (let step = 1; step <= MAX_PAGES; step++) {
      filledTotal += await fillPage(page, respondent);

      const next = page.getByRole('button', { name: 'Berikutnya', exact: true });

      if ((await next.count()) === 0 || !(await next.first().isVisible())) break;

      await next.first().click();
      await page.waitForTimeout(600);
      await page.waitForLoadState('networkidle');
    }

    if (dryRun) {
      return { ...summary, filled: filledTotal, status: 'dry-run' };
    }

    const submitButton = page.getByRole('button', { name: 'Kirim', exact: true });

    if ((await submitButton.count()) === 0) {
      throw new Error('Tombol Kirim tidak ditemukan (mungkin ada isian wajib kosong)');
    }

    await submitButton.first().click();
    await page.waitForTimeout(2500);

    const body = await page.locator('body').innerText();
    const recorded = /Jawaban Anda telah direkam|Your response has been recorded/i.test(body);

    if (!recorded) {
      throw new Error('Konfirmasi "Jawaban Anda telah direkam" tidak muncul');
    }

    return {
      ...summary,
      filled: filledTotal,
      status: 'submitted',
      submittedAt: new Date().toISOString()
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

module.exports = { submit, FORM_URL };

if (require.main === module) {
  const respondentId = process.argv[2];

  if (!respondentId) {
    console.error('Pakai: node cloud-submit.js R02 [--dry-run]');
    process.exit(1);
  }

  submit(respondentId, { dryRun: process.argv.includes('--dry-run') })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error.message);
      process.exit(1);
    });
}
