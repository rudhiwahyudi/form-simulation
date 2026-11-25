const { loadSchedule, loadState, RESPONDENT_IDS } = require('./lib/schedule');
const { buildRespondents } = require('./lib/simulation');

// Menampilkan perbandingan antara data yang seharusnya ada (jadwal),
// yang sudah terkirim (state), dan nama asli tiap responden.
// Dipakai untuk memastikan spreadsheet dan state tidak berselisih.
function main() {
  const schedule = loadSchedule();
  const state = loadState();
  const respondents = buildRespondents(10);

  if (!schedule) {
    console.error('Belum ada data/schedule.json. Jalankan: npm run schedule');
    process.exit(1);
  }

  console.log('Jendela  :', schedule.windowStart, 's/d', schedule.windowEnd);
  console.log('');

  const byId = new Map(respondents.map(item => [item.id, item]));
  let sent = 0;

  console.log('ID    TARGET   STATUS     NAMA                 DOMISILI');
  console.log('-'.repeat(96));

  for (const entry of schedule.entries) {
    const record = state[entry.respondentId];
    const respondent = byId.get(entry.respondentId);
    const status = record ? 'TERKIRIM' : 'menunggu';

    if (record) sent++;

    console.log(
      entry.respondentId.padEnd(5) +
        entry.targetAt.slice(11, 16).padEnd(9) +
        status.padEnd(11) +
        (respondent ? respondent.demographics.nama : '-').padEnd(21) +
        (respondent ? respondent.demographics.domisili.slice(0, 34) : '-')
    );
  }

  console.log('-'.repeat(96));
  console.log(`Terkirim: ${sent} / ${RESPONDENT_IDS.length}`);

  const orphans = Object.keys(state).filter(
    id => !schedule.entries.some(entry => entry.respondentId === id)
  );

  if (orphans.length) {
    console.log(`PERINGATAN: state berisi ID di luar jadwal: ${orphans.join(', ')}`);
  }

  if (sent === RESPONDENT_IDS.length) {
    console.log('Semua responden sudah terkirim.');
  }
}

main();
