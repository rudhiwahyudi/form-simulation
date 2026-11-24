const fs = require('fs');
const path = require('path');

// Menyimpan hasil semua run supaya CSV tidak tertimpa saat submit diulang
// (mis. hanya mengirim ulang responden yang gagal).
const STATE_FILE = path.join(__dirname, '..', 'output', 'state.json');

function load() {
  if (!fs.existsSync(STATE_FILE)) return {};

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function upsert(respondent) {
  const state = load();

  state[respondent.id] = {
    id: respondent.id,
    profile: respondent.profile,
    demographics: respondent.demographics,
    answers: respondent.answers,
    submittedAt: respondent.submittedAt || null,
    status: respondent.status || 'PENDING'
  };

  save(state);

  return state;
}

function submitted() {
  return Object.values(load())
    .filter(entry => entry.status === 'BERHASIL')
    .sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { load, save, upsert, submitted, STATE_FILE };
