/** Slug generation: kebab-case from a (possibly Russian) free-text description. */

const RU_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const STOP_WORDS_RAW = [
  // ru (stored transliterated below, since filtering happens post-transliteration)
  'сделай', 'сделать', 'создай', 'создать', 'сервис', 'который', 'которая',
  'чтобы', 'когда', 'и', 'в', 'на', 'с', 'по', 'для', 'из', 'мне', 'его',
  'это', 'если', 'раз', 'или', 'не', 'а', 'но', 'же', 'бы', 'у', 'к', 'о',
  // en
  'make', 'build', 'create', 'a', 'an', 'the', 'service', 'app', 'that',
  'which', 'with', 'for', 'and', 'to', 'of', 'in', 'on', 'me', 'my', 'it',
];

export function transliterate(text: string): string {
  return text
    .toLowerCase()
    .split('')
    .map((ch) => (ch in RU_MAP ? RU_MAP[ch] : ch))
    .join('');
}

const STOP_WORDS = new Set(STOP_WORDS_RAW.map(transliterate));

/** Derive a short kebab-case slug from a service description. */
export function slugFromDescription(description: string, maxWords = 3): string {
  const words = transliterate(description)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  const picked = words.slice(0, maxWords);
  let slug = picked.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) slug = 'service';
  return slug.slice(0, 40).replace(/-$/, '');
}

/** Resolve collisions by suffixing -2, -3, ... */
export function uniqueSlug(base: string, exists: (slug: string) => boolean): string {
  if (!exists(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Could not find a free slug for ${base}`);
}

export function isValidSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(s) || /^[a-z0-9]$/.test(s);
}
