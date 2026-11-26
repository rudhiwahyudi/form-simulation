const { execSync } = require('child_process');
const { run } = require('./run-schedule');
const { loadState, loadSchedule } = require('./lib/schedule');

// Cron GitHub Actions tidak bisa diandalkan untuk interval 5 menit: pada repo
// ini hanya 2 dari ~300 jadwal yang benar-benar dipicu. Karena itu satu job
// dibuat berjalan lama (loop internal) dan cron dipakai hanya untuk menyambung.
const INTERVAL_MS = 5 * 60 * 1000;
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS) || Infinity;
const CI = process.env.GITHUB_ACTIONS === 'true';
const DRY_RUN = process.env.DRY_RUN === 'true';
const FORCE = process.env.RESPONDENT || null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function timestamp() {
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function showStatus() {
  const schedule = loadSchedule();
  const state = loadState();

  if (!schedule) {
    log('Belum ada jadwal.');
    return;
  }

  log(`Jendela: ${schedule.windowStart} s/d ${schedule.windowEnd}`);

  for (const entry of schedule.entries) {
    const done = state[entry.respondentId];

    log(
      `  ${entry.respondentId} target ${entry.targetAt.slice(11, 16)} ` +
        `${done ? 'TERKIRIM' : 'menunggu'}`
    );
  }
}

// State harus tersimpan tepat setelah submit. Kalau hanya di-commit di akhir
// job, runner yang terhenti membuat responden terkirim dua kali.
function commitState() {
  if (!CI || DRY_RUN) return;

  const git = args => execSync(`git ${args}`, { stdio: 'pipe' }).toString();

  try {
    git('add data');

    if (!git('status --porcelain data').trim()) return;

    git(
      '-c user.name="github-actions[bot]" ' +
        '-c user.email="41898282+github-actions[bot]@users.noreply.github.com" ' +
        'commit -m "chore: update jadwal & state pengisian"'
    );

    try {
      git('push');
    } catch {
      git('pull --rebase --autostash');
      git('push');
    }

    log('State tersimpan ke repo.');
  } catch (error) {
    log(`GAGAL simpan state: ${error.message}`);
  }
}

async function tick() {
  try {
    const report = await run({ dryRun: DRY_RUN, force: FORCE });
    const result = report.results[0] || {};

    switch (result.status) {
      case 'waiting':
        log(`Menunggu ${result.respondentId} (target ${result.targetAt.slice(11, 16)})`);
        return 'continue';
      case 'submitted':
        log(`TERKIRIM ${result.respondentId} - ${result.name} (${result.filled} isian)`);
        commitState();
        return 'continue';
      case 'skipped-already-in-sheet':
        log(`LEWATI ${result.respondentId} - nama sudah ada di spreadsheet`);
        commitState();
        return 'continue';
      case 'failed':
        log(`GAGAL ${result.respondentId}: ${result.error}`);
        return 'continue';
      case 'done':
        log('Semua responden sudah terkirim.');
        return 'done';
      default:
        log(`${result.status}: ${result.respondentId || '-'}`);
        return 'continue';
    }
  } catch (error) {
    log(`ERROR: ${error.message}`);
    return 'continue';
  }
}

async function main() {
  showStatus();

  if (FORCE) {
    await tick();
    return;
  }

  const deadline = Date.now() + MAX_RUNTIME_MS;

  log(
    `Loop aktif, cek tiap ${INTERVAL_MS / 60000} menit.` +
      (MAX_RUNTIME_MS === Infinity
        ? ' Tekan Ctrl+C untuk berhenti.'
        : ` Batas ${MAX_RUNTIME_MS / 3600000} jam.`)
  );

  while (Date.now() < deadline) {
    if ((await tick()) === 'done') return;

    if (Date.now() + INTERVAL_MS >= deadline) break;

    await sleep(INTERVAL_MS);
  }

  log('Batas waktu tercapai; run berikutnya melanjutkan sisa jadwal.');
}

main();
