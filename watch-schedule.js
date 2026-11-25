const { run } = require('./run-schedule');
const { loadState, loadSchedule } = require('./lib/schedule');

// GitHub Actions tidak memicu cron pada repo ini (0 run selama ~30 menit,
// termasuk workflow probe minimal). Loop lokal ini menjalankan penjadwal
// dengan interval yang sama sehingga data tetap masuk sesuai jadwal.
const INTERVAL_MS = 5 * 60 * 1000;

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

async function tick() {
  try {
    const report = await run();
    const result = report.results[0] || {};

    if (result.status === 'waiting') {
      log(`Menunggu ${result.respondentId} (target ${result.targetAt.slice(11, 16)})`);
    } else if (result.status === 'submitted') {
      log(`TERKIRIM ${result.respondentId} - ${result.name} (${result.filled} isian)`);
    } else if (result.status === 'failed') {
      log(`GAGAL ${result.respondentId}: ${result.error}`);
    } else if (result.status === 'done') {
      log('Semua responden sudah terkirim.');
      return true;
    } else {
      log(`${result.status}: ${result.respondentId || '-'}`);
    }
  } catch (error) {
    log(`ERROR: ${error.message}`);
  }

  return false;
}

async function main() {
  showStatus();
  log(`Loop aktif, cek tiap ${INTERVAL_MS / 60000} menit. Tekan Ctrl+C untuk berhenti.`);

  const finished = await tick();

  if (finished) return;

  setInterval(async () => {
    const done = await tick();

    if (done) process.exit(0);
  }, INTERVAL_MS);
}

main();
