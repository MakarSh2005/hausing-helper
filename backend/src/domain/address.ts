/**
 * Адреса: канонический ключ дома, разбор свободного ввода и нечёткий поиск.
 * «Баумана 15», «ул. Баумана, д. 15», «улица баумана дом 15 кв 42», «Бауманна 15» → один дом.
 */

const STREET_TYPES = new Set([
  'ул', 'улица', 'пр', 'пр-т', 'пркт', 'проспект', 'пер', 'переулок', 'б-р', 'бульвар', 'ш', 'шоссе',
  'пл', 'площадь', 'наб', 'набережная', 'проезд', 'тракт', 'им', 'имени',
]);
// В JS \b понимает только латиницу — для кириллицы границы слова задаём явно.
const L = '(?<![а-яa-z0-9])';
const R = '(?![а-яa-z0-9])';
const CITY_WORDS = new RegExp(`${L}(г|город|казань|рт|республика|татарстан|россия|рф)${R}`, 'g');
const APARTMENT = new RegExp(`${L}(?:кв|квартира)\\s*(\\d{1,4}[а-я]?)${R}`);
const BUILDING = new RegExp(`${L}(?:корпус|корп|к)\\s*(\\d{1,3})${R}`);
const HOUSE_WORD = new RegExp(`${L}(?:дом|д)${R}`, 'g');

export function normalizePart(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'.,;:()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Улица без типа («ул.», «проспект»…) и знаков: «ул. Мусы Джалиля» → «мусы джалиля». */
export function normalizeStreet(street: string): string {
  return normalizePart(street)
    .split(' ')
    .filter((t) => t && !STREET_TYPES.has(t))
    .join(' ');
}

export function houseKey(city: string, street: string, houseNumber: string, building?: string | null): string {
  const num = normalizePart(houseNumber).replace(/^(дом|д)\s*/, '').replace(/\s/g, '');
  // Длинные варианты раньше коротких: иначе «корпус 2» → «орпус2».
  const b = building ? normalizePart(building).replace(/^(корпус|корп|к)\s*/, '').replace(/\s/g, '') : '';
  return [normalizePart(city), normalizeStreet(street), num, b].join('|');
}

export interface AddressQuery {
  street: string; // нормализованная улица
  houseNumber?: string; // «15», «15а»
  building?: string; // корпус
  /** «13/6» целиком: в Казани дробью чаще пишут угловые дома, а не корпуса. */
  fraction?: string;
  apartment?: string; // если пользователь сразу написал «кв. 42»
}

/**
 * Разбор свободного ввода. Номер дома — последнее число с необязательной литерой;
 * всё до него — улица. «кв 42» и «корп 2» вынимаются отдельно.
 */
export function parseAddressQuery(input: string): AddressQuery {
  let t = normalizePart(input).replace(CITY_WORDS, ' ');

  let apartment: string | undefined;
  t = t.replace(APARTMENT, (_m, a: string) => {
    apartment = a;
    return ' ';
  });

  let building: string | undefined;
  t = t.replace(BUILDING, (_m, b: string) => {
    building = b;
    return ' ';
  });
  // «13/6» — либо угловой дом (номер целиком), либо дом и корпус: какое из двух — решает matchHouse
  let fraction: string | undefined;
  t = t.replace(/(\d+[а-я]?)\s*\/\s*(\d{1,3}[а-я]?)(?![0-9])/, (_m, n: string, b: string) => {
    fraction = `${n}/${b}`;
    building ??= b.replace(/[а-я]$/, '');
    return n;
  });

  // Номер дома: последнее «число+литера», допускаем «д 15», «дом 15», «15 а»
  const re = /(?:^|\s)(?:дом|д)?\s*(\d{1,4})\s*([а-я])?(?=\s|$)/g;
  let m: RegExpExecArray | null;
  let last: { index: number; len: number; num: string } | undefined;
  while ((m = re.exec(t))) last = { index: m.index, len: m[0].length, num: m[1]! + (m[2] ?? '') };

  let houseNumber: string | undefined;
  let streetPart = t;
  if (last) {
    houseNumber = last.num;
    streetPart = (t.slice(0, last.index) + ' ' + t.slice(last.index + last.len)).trim();
  }
  streetPart = streetPart.replace(HOUSE_WORD, ' ');
  return { street: normalizeStreet(streetPart), houseNumber, building, apartment, ...(fraction ? { fraction } : {}) };
}

const numKey = (n: string) => n.toLowerCase().replace(/ё/g, 'е').replace(/\s/g, '');

/** Расстояние Левенштейна (для опечаток в названии улицы). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Похожесть улиц 0..1: точное совпадение, вхождение, совпадение фамилии («джалиля»), опечатки. */
export function streetSimilarity(query: string, street: string): number {
  if (!query || !street) return 0;
  if (query === street) return 1;
  if (query.length >= 4 && (street.includes(query) || query.includes(street))) return 0.92;
  const qt = query.split(' ').filter((x) => x.length >= 4);
  const st = street.split(' ').filter((x) => x.length >= 4);
  let token = 0;
  for (const a of qt) for (const b of st) {
    const d = levenshtein(a, b);
    if (d === 0) token = Math.max(token, 0.9);
    else if (d === 1 || (d === 2 && Math.min(a.length, b.length) >= 7)) token = Math.max(token, 0.82);
  }
  const whole = 1 - levenshtein(query, street) / Math.max(query.length, street.length);
  return Math.max(token, whole);
}

export interface HouseRef {
  id: string;
  street: string;
  houseNumber: string;
  building: string | null;
}

export type HouseMatch<H extends HouseRef> =
  /** Дом найден (может быть несколько корпусов — тогда уточняем кнопками). */
  | { kind: 'found'; houses: H[]; query: AddressQuery }
  /** Улица есть, такого номера нет — предлагаем номера на этой улице. */
  | { kind: 'no_number'; street: string; houses: H[]; query: AddressQuery }
  /** Номер не указан — предлагаем дома на улице. */
  | { kind: 'need_number'; street: string; houses: H[]; query: AddressQuery }
  /** Улица не найдена. */
  | { kind: 'not_found'; query: AddressQuery };

const STREET_THRESHOLD = 0.75;

export function matchHouse<H extends HouseRef>(input: string, houses: H[]): HouseMatch<H> {
  const query = parseAddressQuery(input);
  if (!query.street) return { kind: 'not_found', query };

  // Лучшая улица (при равенстве — первая по алфавиту, чтобы ответ был стабильным)
  const streets = [...new Set(houses.map((h) => h.street))].sort();
  let best: { street: string; score: number } | undefined;
  for (const s of streets) {
    const score = streetSimilarity(query.street, normalizeStreet(s));
    if (!best || score > best.score) best = { street: s, score };
  }
  if (!best || best.score < STREET_THRESHOLD) return { kind: 'not_found', query };

  const onStreet = houses
    .filter((h) => h.street === best!.street)
    .sort((a, b) => parseInt(a.houseNumber, 10) - parseInt(b.houseNumber, 10) || a.houseNumber.localeCompare(b.houseNumber));
  if (!query.houseNumber) return { kind: 'need_number', street: best.street, houses: onStreet, query };

  // 1) «13/6» — угловой дом с таким номером целиком
  if (query.fraction) {
    const whole = onStreet.filter((h) => numKey(h.houseNumber) === numKey(query.fraction!));
    if (whole.length) return { kind: 'found', houses: whole, query: { ...query, building: undefined } };
  }
  // 2) номер + корпус
  const num = numKey(query.houseNumber);
  let found = onStreet.filter((h) => numKey(h.houseNumber) === num);
  if (query.building) {
    const exact = found.filter((h) => (h.building ?? '') === query.building);
    if (exact.length) found = exact;
  }
  if (found.length) return { kind: 'found', houses: found, query };
  // 3) написали «13», а в справочнике угловой «13/6» — это тот же дом
  const corner = onStreet.filter((h) => numKey(h.houseNumber).startsWith(`${num}/`));
  if (corner.length) return { kind: 'found', houses: corner, query };
  return { kind: 'no_number', street: best.street, houses: onStreet, query };
}

export function formatAddress(h: { street: string; houseNumber: string; building?: string | null }): string {
  return `${h.street}, д. ${h.houseNumber}${h.building ? `, корп. ${h.building}` : ''}`;
}
