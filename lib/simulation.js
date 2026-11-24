const questions = require('./questions.json');

// Skor Likert 4 titik: STS=1 ... SS=4
const LIKERT = {
  'Sangat Tidak Setuju': 1,
  'Tidak Setuju': 2,
  Setuju: 3,
  'Sangat Setuju': 4
};

const LIKERT_LABELS = Object.keys(LIKERT);

const DIMENSIONS = {
  'grc.success_power_competition': { scale: 'grc', label: 'GRC - Success, Power, Competition' },
  'grc.restrictive_emotionality': { scale: 'grc', label: 'GRC - Restrictive Emotionality' },
  'grc.restrictive_affection': { scale: 'grc', label: 'GRC - Restrictive Affectionate Behavior' },
  'grc.work_family_conflict': { scale: 'grc', label: 'GRC - Work-Family Conflict' },
  'help.openness': { scale: 'help', label: 'Help-Seeking - Keterbukaan' },
  'help.intention': { scale: 'help', label: 'Help-Seeking - Intensi' },
  'help.social_barrier': { scale: 'help', label: 'Help-Seeking - Hambatan Sosial' },
  'burnout.emotional_exhaustion': { scale: 'burnout', label: 'Burnout - Kelelahan Emosional' },
  'burnout.cynicism': { scale: 'burnout', label: 'Burnout - Sinisme' },
  'burnout.professional_efficacy': { scale: 'burnout', label: 'Burnout - Efikasi Profesional' }
};

const SCALE_LABELS = {
  grc: 'Gender Role Conflict',
  help: 'Psychological Help-Seeking',
  burnout: 'Burnout'
};

const PROFILES = [
  { id: 'R01', name: 'Dominan Sangat Setuju', weights: [0.05, 0.10, 0.25, 0.60] },
  { id: 'R02', name: 'Dominan Setuju', weights: [0.05, 0.15, 0.60, 0.20] },
  { id: 'R03', name: 'Dominan Tidak Setuju', weights: [0.15, 0.60, 0.20, 0.05] },
  { id: 'R04', name: 'Dominan Sangat Tidak Setuju', weights: [0.60, 0.25, 0.10, 0.05] },
  { id: 'R05', name: 'Cenderung Tengah', weights: [0.15, 0.35, 0.35, 0.15] },
  { id: 'R06', name: 'Variasi Tinggi', weights: [0.25, 0.25, 0.25, 0.25] },
  { id: 'R07', name: 'Cenderung Positif', weights: [0.05, 0.20, 0.35, 0.40] },
  { id: 'R08', name: 'Cenderung Negatif', weights: [0.40, 0.35, 0.20, 0.05] },
  { id: 'R09', name: 'Variasi Moderat', weights: [0.20, 0.30, 0.30, 0.20] },
  { id: 'R10', name: 'Pola Campuran', weights: [0.30, 0.20, 0.20, 0.30] }
];

const DUMMY_RESPONDENTS = [
  { name: 'Adit Hermawan', domisili: 'Caturharjo, Kec. Sleman, Kab. Sleman, DIY' },
  { name: 'Rama Nugraha', domisili: 'Pandowoharjo, Kec. Sleman, Kab. Sleman, DIY' },
  { name: 'Bayu Santoso', domisili: 'Triharjo, Kec. Sleman, Kab. Sleman, DIY' },
  { name: 'Dimas Prasetyo', domisili: 'Trimulyo, Kec. Sleman, Kab. Sleman, DIY' },
  { name: 'Rizky Maulana', domisili: 'Sendangadi, Kec. Mlati, Kab. Sleman, DIY' },
  { name: 'Arga Saputra', domisili: 'Sinduadi, Kec. Mlati, Kab. Sleman, DIY' },
  { name: 'Fajar Kurniawan', domisili: 'Sumberadi, Kec. Mlati, Kab. Sleman, DIY' },
  { name: 'Naufal Adrianto', domisili: 'Tirtoadi, Kec. Mlati, Kab. Sleman, DIY' },
  { name: 'Bagas Wijaya', domisili: 'Margomulyo, Kec. Seyegan, Kab. Sleman, DIY' },
  { name: 'Yoga Putra', domisili: 'Margoagung, Kec. Seyegan, Kab. Sleman, DIY' }
];

const SCALE_QUESTIONS = questions.filter(q => q.dimension);
const TEXT_QUESTIONS = questions.filter(q => q.type === 'text');
const CONSENT_QUESTION = questions.find(q => q.type === 'choice' && q.options.length === 2 && q.formIndex === 0);

// PRNG deterministik: seed sama -> jawaban sama, jadi hasil bisa direproduksi
// dan CSV lokal konsisten dengan apa yang dikirim ke form.
function mulberry32(seed) {
  let state = seed >>> 0;

  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(text) {
  let hash = 2166136261;

  for (const char of String(text)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function pickWeighted(weights, random) {
  let cumulative = 0;

  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];

    if (random <= cumulative) {
      return i + 1;
    }
  }

  return LIKERT_LABELS.length;
}

// Jawaban disimpan sebagai label agar bisa langsung dipakai untuk klik di form.
function generateAnswers(profile, random = Math.random) {
  const answers = {};

  for (const question of SCALE_QUESTIONS) {
    answers[question.entry] = LIKERT_LABELS[pickWeighted(profile.weights, random()) - 1];
  }

  return answers;
}

function toScore(label, reverse) {
  const value = LIKERT[label];

  return reverse ? 5 - value : value;
}

function categorize(mean) {
  if (mean <= 1.75) return 'Sangat Rendah';
  if (mean <= 2.5) return 'Rendah';
  if (mean <= 3.25) return 'Tinggi';

  return 'Sangat Tinggi';
}

function mean(values) {
  if (!values.length) return 0;

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function scoreAnswers(answers) {
  const perDimension = {};

  for (const question of SCALE_QUESTIONS) {
    const label = answers[question.entry];

    if (!label) {
      throw new Error(`Jawaban untuk item ${question.formIndex} (${question.entry}) belum ada`);
    }

    const bucket = (perDimension[question.dimension] ||= []);
    bucket.push(toScore(label, question.reverse));
  }

  const dimensions = Object.entries(perDimension).map(([key, values]) => ({
    key,
    label: DIMENSIONS[key].label,
    scale: DIMENSIONS[key].scale,
    itemCount: values.length,
    mean: Number(mean(values).toFixed(2)),
    category: categorize(mean(values))
  }));

  const perScale = {};

  for (const dimension of dimensions) {
    (perScale[dimension.scale] ||= []).push(dimension.mean);
  }

  const scales = Object.entries(perScale).map(([key, means]) => {
    const value = Number(mean(means).toFixed(2));

    return {
      key,
      label: SCALE_LABELS[key],
      mean: value,
      category: categorize(value)
    };
  });

  return { dimensions, scales };
}

function buildRespondents(count = PROFILES.length, seed = 'tryout-2026') {
  return PROFILES.slice(0, count).map((profile, index) => {
    const random = mulberry32(seedFor(`${seed}:${profile.id}`));
    const answers = generateAnswers(profile, random);
    const dummy = DUMMY_RESPONDENTS[index];
    const demographics = {
      nama: dummy.name,
      usia: 22 + ((index * 3) % 19),
      statusPekerjaan: 'Aktif',
      domisili: dummy.domisili,
      lamaBekerja: 'Lebih dari 1 tahun'
    };

    return {
      id: profile.id,
      profile: profile.name,
      demographics,
      answers,
      scores: scoreAnswers(answers)
    };
  });
}

module.exports = {
  LIKERT,
  LIKERT_LABELS,
  DIMENSIONS,
  SCALE_LABELS,
  PROFILES,
  SCALE_QUESTIONS,
  TEXT_QUESTIONS,
  CONSENT_QUESTION,
  generateAnswers,
  scoreAnswers,
  categorize,
  buildRespondents
};
