// Deterministic, human-friendly race names generated from race ID
// Ensures high variety and avoids obvious duplicates by combining multiple word lists

// Word lists kept intentionally short and clean; extend as desired
const adjectives = [
  "Blazing", "Quantum", "Neon", "Turbo", "Cosmic", "Galactic", "Crimson", "Electric",
  "Wild", "Shadow", "Atomic", "Hyper", "Sonic", "Lunar", "Solar", "Feral", "Vivid", "Savage",
  "Phantom", "Ultra", "Zen", "Meta", "Vortex", "Rapid", "Fury", "Scarlet", "Emerald"
];

const nouns = [
  "Sprint", "Derby", "Dash", "Grand Prix", "Circuit", "Showdown", "Rally", "Run",
  "Charge", "Stampede", "Rush", "Blitz", "Gauntlet", "Shootout", "Skirmish", "Series",
  "Classic", "Cup", "Open", "Challenge", "Invitational", "Heat", "Finale", "Spectacle"
];

const locales = [
  "Monaco", "Tokyo", "Vegas", "Miami", "Neo City", "Arcadia", "Sol Valley", "Mirage",
  "Apex", "Horizon", "Odyssey", "Zenith", "Nova", "Aurora", "Vertex", "Cascade"
];

function xmur3(str: string): () => number {
  // Simple hash seed generator -> 32-bit
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, list: T[]): T {
  return list[Math.floor(rng() * list.length) % list.length];
}

export function getRaceDisplayName(raceId: string): string {
  // Compact, human-friendly tag with deterministic 2-digit suffix, e.g., "Electric Cup #47"
  const tag = getShortRaceTag(raceId);
  let suffixNum: number | null = null;
  const src = raceId || '';
  if (src) {
    const seed = xmur3(`${src}:display`)();
    const rng = mulberry32(seed);
    // 2-digit number between 10 and 99
    suffixNum = Math.floor(rng() * 90) + 10;
  }
  return suffixNum !== null ? `${tag} #${suffixNum}` : tag;
}

export function getShortRaceTag(raceId: string): string {
  // For compact contexts: e.g., "Neon Classic"
  const seedStr = `${raceId || ''}:${(raceId || '').slice(-6)}:${(raceId || '').length}`;
  const seed = xmur3(seedStr)();
  const rng = mulberry32(seed);

  const adj = pick(rng, adjectives);
  const noun = pick(rng, nouns);
  return `${adj} ${noun}`;
}

export function getUniqueOverlayLabel(raceId: string, fallbackIndex?: number): string {
  // For future race overlay (used to show next races); include a short tag + seeded numeric suffix
  const tag = getShortRaceTag(raceId);
  // Avoid leaking internal id suffixes like "_0"; instead use a stable seeded 2-digit number
  let suffixNum: number | null = null;
  const src = raceId || '';
  if (src) {
    const seed = xmur3(`${src}:overlay`)();
    const rng = mulberry32(seed);
    // Generate a 2-digit number between 10 and 99 for a clean, compact label
    suffixNum = Math.floor(rng() * 90) + 10;
  } else if (typeof fallbackIndex === 'number') {
    // Deterministic fallback when raceId is missing
    suffixNum = ((fallbackIndex % 90) + 10);
  }
  return suffixNum !== null ? `${tag} #${suffixNum}` : tag;
}

