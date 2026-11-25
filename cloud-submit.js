const questions = require('./lib/questions.json');
const { buildRespondents } = require('./lib/simulation');

const FORM_RESPONSE_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSdjYJy4xzVl28dGCUzNAY2zIm9W4uoxO0bjs12GMjT2AyAZRA/formResponse';

// Google membalas halaman konfirmasi bila jawaban benar-benar tersimpan.
// Tanpa pengecekan ini, HTTP 200 bisa disalahartikan sebagai sukses.
const CONFIRMATION_TEXT = 'telah direkam';

function answerFor(question, respondent) {
  if (question.dimension) return respondent.answers[question.entry];

  switch (question.formIndex) {
    case 0:
      return 'Ya';
    case 2:
      return respondent.demographics.nama;
    case 3:
      return String(respondent.demographics.usia);
    case 4:
      return respondent.demographics.statusPekerjaan;
    case 5:
      return respondent.demographics.domisili;
    case 6:
      return respondent.demographics.lamaBekerja;
    default:
      return null;
  }
}

function buildBody(respondent) {
  const body = new URLSearchParams();

  body.set('fvv', '1');
  body.set('pageHistory', '0');
  body.set('submissionTimestamp', '-1');

  for (const question of questions) {
    if (!question.entry) continue;

    const value = answerFor(question, respondent);

    if (value !== null) {
      body.set(`entry.${question.entry}`, value);
    }
  }

  return body;
}

function findRespondent(respondentId) {
  const respondent = buildRespondents(10).find(item => item.id === respondentId);

  if (!respondent) throw new Error(`Respondent tidak valid: ${respondentId}`);

  return respondent;
}

function plainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function submit(respondentId, { dryRun = false } = {}) {
  const respondent = findRespondent(respondentId);
  const body = buildBody(respondent);

  const summary = {
    respondentId,
    name: respondent.demographics.nama,
    domisili: respondent.demographics.domisili,
    entries: body.size
  };

  if (dryRun) {
    return { ...summary, status: 'dry-run' };
  }

  const response = await fetch(FORM_RESPONSE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (compatible; form-simulation-scheduler)'
    },
    body,
    redirect: 'follow'
  });

  const html = await response.text();

  if (!response.ok) {
    throw new Error(`Google Form menolak respons: HTTP ${response.status}`);
  }

  if (!plainText(html).includes(CONFIRMATION_TEXT)) {
    throw new Error('Google Form tidak mengonfirmasi penyimpanan jawaban');
  }

  return {
    ...summary,
    status: 'submitted',
    httpStatus: response.status,
    submittedAt: new Date().toISOString()
  };
}

module.exports = { submit, buildBody, findRespondent, FORM_RESPONSE_URL };

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
