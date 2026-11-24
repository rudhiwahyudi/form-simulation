const questions = require('./lib/questions.json');
const { buildRespondents } = require('./lib/simulation');

const FORM_RESPONSE_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSdjYJy4xzVl28dGCUzNAY2zIm9W4uoxO0bjs12GMjT2AyAZRA/formResponse';

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

async function submit(respondentId) {
  const respondent = buildRespondents(10).find(item => item.id === respondentId);

  if (!respondent) throw new Error(`Respondent tidak valid: ${respondentId}`);

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

  const response = await fetch(FORM_RESPONSE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (compatible; form-simulation-scheduler)'
    },
    body,
    redirect: 'follow'
  });

  if (!response.ok && response.status !== 0) {
    throw new Error(`Google Form menolak respons: HTTP ${response.status}`);
  }

  console.log(
    JSON.stringify({
      respondentId,
      name: respondent.demographics.nama,
      status: 'submitted',
      httpStatus: response.status,
      submittedAt: new Date().toISOString()
    })
  );
}

const respondentId = process.argv[2];

if (!respondentId) {
  console.error('Pakai: node cloud-submit.js R02');
  process.exit(1);
}

submit(respondentId).catch(error => {
  console.error(error.message);
  process.exit(1);
});
