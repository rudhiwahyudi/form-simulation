const { submit } = require('./cloud-submit');
const { buildRespondents } = require('./lib/simulation');
const {
  RESPONDENT_IDS,
  ensureSchedule,
  saveSchedule,
  loadState,
  saveState,
  reanchor
} = require('./lib/schedule');

// Cegah duplikat: kalau nama sudah ada di spreadsheet, responden dianggap
// terkirim. Sumbernya CSV "publish to web" (read-only, tanpa login).
async function knownNames() {
  const url = process.env.SHEET_CSV_URL;

  if (!url) return null;

  try {
    const response = await fetch(url, { redirect: 'follow' });

    if (!response.ok) return null;

    const names = new Set();
    const lines = (await response.text()).split(/\r?\n/).slice(1);

    for (const line of lines) {
      // shortcut: nama diasumsikan tanpa koma/kutip, jadi split koma cukup
      const name = line.split(',')[2];

      if (name) names.add(name.replace(/"/g, '').trim().toLowerCase());
    }

    return names;
  } catch {
    return null;
  }
}

// Satu run hanya mengirim satu responden. Dengan begitu jarak 3-5 jam antar
// pengisian selalu terjaga, dan jadwal yang terlewat tidak pernah hilang:
// sisa jadwal digeser dari waktu submit sebenarnya.
function nextEntry(schedule, state) {
  return schedule.entries.find(entry => !state[entry.respondentId]) || null;
}

function isDue(entry, now) {
  return Date.parse(entry.targetAt) <= now;
}

async function run({ dryRun = false, force = null, now = Date.now() } = {}) {
  const schedule = ensureSchedule(now);
  const state = loadState();

  const entry = force
    ? schedule.entries.find(item => item.respondentId === force)
    : nextEntry(schedule, state);

  if (force && !entry) {
    throw new Error(`Respondent tidak ada di jadwal: ${force}`);
  }

  const report = {
    now: new Date(now).toISOString(),
    windowStart: schedule.windowStart,
    windowEnd: schedule.windowEnd,
    pending: schedule.entries.filter(item => !state[item.respondentId]).length,
    results: []
  };

  if (!entry) {
    report.results.push({ status: 'done', message: 'Semua responden sudah terkirim' });

    return report;
  }

  if (state[entry.respondentId]) {
    report.results.push({
      respondentId: entry.respondentId,
      status: 'skipped-already-sent'
    });

    return report;
  }

  if (!force && !isDue(entry, now)) {
    report.results.push({
      respondentId: entry.respondentId,
      status: 'waiting',
      targetAt: entry.targetAt
    });

    return report;
  }

  const name = buildRespondents(10).find(item => item.id === entry.respondentId)
    ?.demographics.nama;
  const names = force ? null : await knownNames();

  if (names && name && names.has(name.trim().toLowerCase())) {
    if (!dryRun) {
      state[entry.respondentId] = {
        respondentId: entry.respondentId,
        name,
        status: 'already-in-sheet',
        targetAt: entry.targetAt,
        submittedAt: new Date(now).toISOString()
      };
      saveState(state);

      const index = schedule.entries.findIndex(
        item => item.respondentId === entry.respondentId
      );

      if (index > -1) {
        reanchor(schedule.entries, index, now, Date.parse(schedule.windowEnd));
        saveSchedule(schedule);
      }
    }

    report.results.push({
      respondentId: entry.respondentId,
      name,
      status: 'skipped-already-in-sheet'
    });

    return report;
  }

  try {
    const result = await submit(entry.respondentId, { dryRun });

    report.results.push(result);

    if (!dryRun) {
      state[entry.respondentId] = {
        respondentId: entry.respondentId,
        name: result.name,
        status: 'submitted',
        targetAt: entry.targetAt,
        submittedAt: result.submittedAt
      };
      saveState(state);

      const index = schedule.entries.findIndex(
        item => item.respondentId === entry.respondentId
      );

      if (index > -1) {
        reanchor(
          schedule.entries,
          index,
          Date.parse(result.submittedAt),
          Date.parse(schedule.windowEnd)
        );
        saveSchedule(schedule);
      }
    }
  } catch (error) {
    report.results.push({
      respondentId: entry.respondentId,
      status: 'failed',
      error: error.message
    });
  }

  return report;
}

module.exports = { run, nextEntry, isDue, RESPONDENT_IDS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const forceArg = args.find(arg => arg.startsWith('--force='));

  run({
    dryRun: args.includes('--dry-run'),
    force: forceArg ? forceArg.slice(8) : null
  })
    .then(report => {
      console.log(JSON.stringify(report, null, 2));

      if (report.results.some(item => item.status === 'failed')) process.exit(1);
    })
    .catch(error => {
      console.error(error.message);
      process.exit(1);
    });
}
