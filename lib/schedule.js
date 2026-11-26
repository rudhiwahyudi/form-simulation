const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const RESPONDENT_IDS = [
  'R01', 'R02', 'R03', 'R04', 'R05',
  'R06', 'R07', 'R08', 'R09', 'R10'
];

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const WIB_OFFSET = 7 * HOUR;

// Jarak antar pengisian: 3 sampai 5 jam.
const GAP_MIN = 3 * HOUR;
const GAP_MAX = 5 * HOUR;

// Poller GitHub Actions jalan tiap 5 menit, jadi target pertama digeser
// ke kelipatan 5 menit berikutnya supaya tidak langsung dianggap terlewat.
const POLL_BUCKET = 5 * MINUTE;
const START_DELAY = 10 * MINUTE;

const pad = value => String(value).padStart(2, '0');

// Timestamp Google Sheets diisi server Google, jadi satu-satunya cara membuat
// jam pengisian "acak" adalah benar-benar submit pada jam tersebut.
function isoWib(ms) {
  const d = new Date(ms + WIB_OFFSET);

  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+07:00`
  );
}

// Batas akhir = pukul 23:59 WIB pada hari setelah tanggal mulai (25 & 26 Nov).
function endOfNextDayWib(ms) {
  const d = new Date(ms + WIB_OFFSET);

  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 2) - WIB_OFFSET - MINUTE;
}

function randomInt(min, maxInclusive) {
  return crypto.randomInt(min, maxInclusive + 1);
}

function fitGaps(gaps, available) {
  const total = gaps.reduce((sum, gap) => sum + gap, 0);

  if (total <= available) return gaps;

  // Perkecil jarak secara proporsional, tetapi tidak pernah di bawah 3 jam.
  const minimum = gaps.length * GAP_MIN;
  const slack = total - minimum;
  const factor = slack > 0 ? Math.max(0, (slack - (total - available)) / slack) : 0;

  return gaps.map(gap => Math.round(GAP_MIN + (gap - GAP_MIN) * factor));
}

function generateSchedule(now = Date.now()) {
  const anchor = Math.ceil((now + START_DELAY) / POLL_BUCKET) * POLL_BUCKET;
  const windowEnd = endOfNextDayWib(anchor);
  const available = Math.max(windowEnd - anchor, 0);

  const rawGaps = [];

  for (let i = 0; i < RESPONDENT_IDS.length - 1; i++) {
    rawGaps.push(randomInt(GAP_MIN, GAP_MAX));
  }

  const gaps = fitGaps(rawGaps, available);
  const entries = [];
  let cursor = anchor;

  RESPONDENT_IDS.forEach((respondentId, index) => {
    if (index > 0) cursor += gaps[index - 1];

    entries.push({
      respondentId,
      targetAt: isoWib(cursor),
      gapMs: index === 0 ? 0 : gaps[index - 1]
    });
  });

  return {
    generatedAt: new Date(now).toISOString(),
    timezone: 'WIB (UTC+7)',
    windowStart: isoWib(anchor),
    windowEnd: isoWib(windowEnd),
    entries
  };
}

// Setelah submit, sisa jadwal digeser dari waktu submit sebenarnya sehingga
// jarak 3-5 jam tetap terjaga walau ada jadwal yang terlewat.
function reanchor(entries, fromIndex, anchorMs, windowEndMs = null) {
  entries[fromIndex].targetAt = isoWib(anchorMs);

  let cursor = anchorMs;

  for (let i = fromIndex + 1; i < entries.length; i++) {
    cursor += entries[i].gapMs;
    entries[i].targetAt = isoWib(cursor);
  }

  if (windowEndMs === null) return;

  // Kalau pergeseran membuat jadwal melewati batas tanggal, rapatkan jarak
  // secara proporsional tetapi tidak pernah di bawah 3 jam.
  const remaining = entries.length - fromIndex - 1;

  if (!remaining || cursor <= windowEndMs) return;

  const available = windowEndMs - anchorMs;
  const minimum = remaining * GAP_MIN;

  if (available <= minimum) {
    cursor = anchorMs;

    for (let i = fromIndex + 1; i < entries.length; i++) {
      cursor += GAP_MIN;
      entries[i].targetAt = isoWib(cursor);
    }

    return;
  }

  const slack = cursor - anchorMs - minimum;
  const factor = (available - minimum) / slack;

  cursor = anchorMs;

  for (let i = fromIndex + 1; i < entries.length; i++) {
    cursor += Math.round(GAP_MIN + (entries[i].gapMs - GAP_MIN) * factor);
    entries[i].targetAt = isoWib(cursor);
  }
}

// Batch dengan window pendek (mis. 15:00-17:00 hari ini): window dibagi rata
// per responden, lalu tiap slot diacak. Sebaran merata tapi jamnya tidak rapi.
function generateWindowSchedule(startMs, endMs, now = Date.now()) {
  const count = RESPONDENT_IDS.length;
  // Kalau window sudah berjalan, pakai sisa waktunya supaya tidak menumpuk di awal.
  const effectiveStart = Math.max(startMs, now + 2 * MINUTE);
  const slot = (endMs - effectiveStart) / count;
  const entries = [];
  let previous = effectiveStart - MINUTE;

  RESPONDENT_IDS.forEach((respondentId, index) => {
    const slotStart = effectiveStart + index * slot;
    const slotEnd = slotStart + slot;
    const earliest = Math.max(slotStart, previous + MINUTE);
    const latest = Math.max(earliest, slotEnd - MINUTE);
    const span = Math.max(0, Math.floor((latest - earliest) / MINUTE));
    const at = earliest + randomInt(0, span) * MINUTE;

    entries.push({
      respondentId,
      targetAt: isoWib(at),
      gapMs: index === 0 ? 0 : at - previous
    });
    previous = at;
  });

  return {
    generatedAt: new Date(now).toISOString(),
    timezone: 'WIB (UTC+7)',
    windowStart: isoWib(startMs),
    windowEnd: isoWib(endMs),
    entries
  };
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function loadSchedule() {
  return readJson(SCHEDULE_FILE, null);
}

function saveSchedule(schedule) {
  writeJson(SCHEDULE_FILE, schedule);
}

function loadState() {
  return readJson(STATE_FILE, {});
}

function saveState(state) {
  writeJson(STATE_FILE, state);
}

function ensureSchedule(now = Date.now()) {
  const existing = loadSchedule();

  if (existing && Array.isArray(existing.entries) && existing.entries.length) {
    return existing;
  }

  const schedule = generateSchedule(now);
  saveSchedule(schedule);

  return schedule;
}

module.exports = {
  DATA_DIR,
  SCHEDULE_FILE,
  STATE_FILE,
  RESPONDENT_IDS,
  GAP_MIN,
  GAP_MAX,
  isoWib,
  generateSchedule,
  generateWindowSchedule,
  reanchor,
  loadSchedule,
  saveSchedule,
  loadState,
  saveState,
  ensureSchedule
};
