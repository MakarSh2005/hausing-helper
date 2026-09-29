/**
 * Seed справочников. Идемпотентен: повторный запуск (он идёт при каждом старте контейнера)
 * ничего не дублирует и не трогает данные пользователей.
 *
 * 1. Дома и УК Казани — из prisma/reference/kazan-houses.json (его делает tools/import_houses.py
 *    из Excel-шаблона). Если данные не отмечены как проверенные или ИНН УК не проходит
 *    проверку контрольной цифры — dataSource = "unverified": бот показывает такие УК
 *    с пометкой «данные уточняются» и не показывает их телефоны.
 * 2. РСО, региональный оператор ТКО, муниципальные службы, фонд капремонта, ГЖИ — синтетические (демо).
 * 3. Правила маршрутизации категорий (responsible_orgs) — из src/domain/norms.ts, со ссылками на нормативы.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { houseKey } from '../src/domain/address.js';
import { isValidOrgInn } from '../src/domain/inn.js';
import { CATEGORY_ORDER, NORMS } from '../src/domain/norms.js';

const db = new PrismaClient();
const CITY = 'Казань';
// Папка не называется «data»: старые правила .dockerignore исключали любые **/data,
// а скрытые файлы (.dockerignore) через веб-загрузку хостинга не обновляются.
const DATA_FILE = path.resolve(process.cwd(), 'prisma/reference/kazan-houses.json');

interface HousesFile {
  city: string;
  verified: boolean;
  source: string;
  actualAt: string;
  organizations: Array<{
    inn: string; name: string; phone: string; dispatcherPhone: string; address: string;
    email: string; website: string; workingHours: string; licenseNumber: string;
    /** false — эту УК не удалось подтвердить: «данные уточняются», даже если справочник в целом проверен */
    verified?: boolean;
  }>;
  houses: Array<{
    code: string; street: string; houseNumber: string; building: string; district: string;
    managerInn: string; yearBuilt: number | null; floors: number | null; entrances: number | null;
    apartmentsCount: number | null;
  }>;
}

/** Меняется, когда меняется сама логика загрузки домов — тогда seed перепишет справочник заново. */
const SEED_VERSION = 'houses-v2';
// Отметка об удачной загрузке лежит рядом с базой (постоянный том): удалили базу — удалится и отметка.
const MARK_FILE = path.join(process.env.DATA_DIR || path.resolve(process.cwd(), 'data'), '.seed-houses');
function readSeedMark(): string | null {
  try {
    return fs.readFileSync(MARK_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}
function writeSeedMark(hash: string) {
  try {
    fs.mkdirSync(path.dirname(MARK_FILE), { recursive: true });
    fs.writeFileSync(MARK_FILE, hash);
  } catch (e) {
    console.warn(`seed: не удалось записать отметку ${MARK_FILE}: ${(e as Error).message}`);
  }
}

/** «25.09.2026» → Date; пусто или мусор → null. */
function parseRuDate(s: string): Date | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s.trim());
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`) : null;
}
const orNull = (s: string) => (s && s.trim() ? s.trim() : null);

async function seedHouses() {
  if (!fs.existsSync(DATA_FILE)) {
    // Не роняем запуск: бот должен оставаться доступным, даже если справочник не доехал до сервера.
    console.error(`seed: ОШИБКА — нет файла справочника ${DATA_FILE}. Дома не загружены, онбординг найдёт только уже имеющиеся в базе.`);
    return { houses: 0, orgs: 0, unverifiedOrgs: 0, housesRemoved: 0, housesKept: 0, orgsRemoved: 0, skipped: false };
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  // Справочник не менялся с прошлого удачного seed — дома не переписываем: 4 тыс. записей — это
  // полторы минуты на каждом рестарте, и всё это время бот недоступен.
  const hash = crypto.createHash('sha256').update(SEED_VERSION).update(raw).digest('hex');
  if (readSeedMark() === hash) {
    console.log('seed: справочник домов не изменился — пропускаю');
    return { houses: 0, orgs: 0, unverifiedOrgs: 0, housesRemoved: 0, housesKept: 0, orgsRemoved: 0, skipped: true };
  }
  const data = JSON.parse(raw) as HousesFile;
  const actualAt = parseRuDate(data.actualAt);
  const orgIdByInn = new Map<string, string>();
  let unverifiedOrgs = 0;

  for (const o of data.organizations) {
    const trusted = data.verified && o.verified !== false && isValidOrgInn(o.inn);
    if (!trusted) unverifiedOrgs++;
    const fields = {
      type: 'UK',
      name: o.name,
      phone: orNull(o.phone),
      dispatcherPhone: orNull(o.dispatcherPhone),
      address: orNull(o.address),
      email: orNull(o.email),
      website: orNull(o.website),
      workingHours: orNull(o.workingHours),
      licenseNumber: orNull(o.licenseNumber),
      city: CITY,
      dataSource: trusted ? 'gis_zhkh' : 'unverified',
      dataActualAt: actualAt,
    };
    const org = await db.organization.upsert({ where: { inn: o.inn }, update: fields, create: { inn: o.inn, ...fields } });
    orgIdByInn.set(o.inn, org.id);
  }

  // ~4 тыс. домов: пишем пачками в транзакциях — по одной записи на диск SQLite это минуты на каждом старте
  const BATCH = 500;
  for (let i = 0; i < data.houses.length; i += BATCH) {
    await db.$transaction(
      async (tx) => {
        for (const h of data.houses.slice(i, i + BATCH)) await upsertHouse(tx, h);
      },
      { maxWait: 20_000, timeout: 120_000 },
    );
  }
  const removed = await removeStale(new Set(data.houses.map((h) => h.code)), new Set(data.organizations.map((o) => o.inn)));
  writeSeedMark(hash);
  return { houses: data.houses.length, orgs: data.organizations.length, unverifiedOrgs, ...removed, skipped: false };

  async function upsertHouse(tx: Prisma.TransactionClient, h: HousesFile['houses'][number]) {
    const managerId = orgIdByInn.get(h.managerInn) ?? null;
    const building = orNull(h.building);
    const fields = {
      city: CITY,
      street: h.street,
      houseNumber: h.houseNumber,
      building,
      normalizedKey: houseKey(CITY, h.street, h.houseNumber, building),
      fullAddress: `${CITY}, ${h.street}, д. ${h.houseNumber}${building ? `, корп. ${building}` : ''}`,
      district: orNull(h.district),
      yearBuilt: h.yearBuilt,
      floors: h.floors,
      entrances: h.entrances,
      apartmentsCount: h.apartmentsCount,
      managerId,
      capRepairFundType: 'regional_operator',
      dataSource: data.verified ? 'gis_zhkh' : 'unverified',
      dataActualAt: actualAt,
    };
    // Тот же адрес уже есть под другим кодом (например, демо-дом первой версии, к которому
    // успели привязаться) — переименовываем код, а не создаём дубль с тем же ключом адреса.
    const sameAddress = await tx.house.findUnique({ where: { normalizedKey: fields.normalizedKey } });
    if (sameAddress && sameAddress.code !== h.code) {
      // Код, который мы хотим дать, может быть занят другим домом — его запись ниже по файлу
      // — отодвигаем его на временный код: если он есть в файле, получит свой код дальше, если нет — уйдёт в removeStale
      const holder = await tx.house.findUnique({ where: { code: h.code } });
      if (holder) await tx.house.update({ where: { id: holder.id }, data: { code: `${h.code}_moved_${holder.id}` } });
      await tx.house.update({ where: { id: sameAddress.id }, data: { code: h.code } });
    }
    await tx.house.upsert({ where: { code: h.code }, update: fields, create: { code: h.code, ...fields } });
  }
}

/**
 * Справочник заменён целиком: дома и УК, которых нет в новом файле, удаляем. Кроме тех, к которым
 * уже привязаны квартиры или заявки жильцов — их оставляем, чтобы не сломать чужие данные.
 */
async function removeStale(codes: Set<string>, inns: Set<string>) {
  let housesRemoved = 0;
  let housesKept = 0;
  // Список кодов не передаём в запрос: 4 тыс. значений в NOT IN превышают лимит параметров SQLite
  // (Prisma P2029). Домов немного — отбираем устаревшие в памяти.
  const all = await db.house.findMany({
    select: { id: true, code: true, _count: { select: { apartments: true, requests: true } } },
  });
  const stale = all.filter((h) => !codes.has(h.code));
  for (const h of stale) {
    if (h._count.apartments === 0 && h._count.requests === 0) {
      await db.house.delete({ where: { id: h.id } });
      housesRemoved++;
    } else housesKept++;
  }
  let orgsRemoved = 0;
  const staleOrgs = (
    await db.organization.findMany({
      where: { type: 'UK' },
      select: { id: true, inn: true, _count: { select: { managedHouses: true, requests: true } } },
    })
  ).filter((o) => !o.inn || !inns.has(o.inn));
  for (const o of staleOrgs) {
    if (o._count.managedHouses === 0 && o._count.requests === 0) {
      await db.organization.delete({ where: { id: o.id } });
      orgsRemoved++;
    }
  }
  return { housesRemoved, housesKept, orgsRemoved };
}

/** Убираем демо-дома и демо-УК первой версии, если на них никто не ссылается. */
async function removeOldDemo() {
  for (const code of ['house_001', 'house_002', 'house_003']) {
    const h = await db.house.findUnique({ where: { code }, include: { _count: { select: { apartments: true, requests: true } } } });
    if (h && h._count.apartments === 0 && h._count.requests === 0) await db.house.delete({ where: { id: h.id } });
  }
  for (const id of ['seed-org-uk-komfort', 'seed-org-uk-uyut']) {
    const o = await db.organization.findUnique({ where: { id }, include: { _count: { select: { managedHouses: true, requests: true } } } });
    if (o && o._count.managedHouses === 0 && o._count.requests === 0) await db.organization.delete({ where: { id } });
  }
}

async function seedServiceOrgs() {
  const orgs = [
    { key: 'rso-heat', type: 'RSO', name: 'Теплоснабжающая организация (демо)' },
    { key: 'rso-water', type: 'RSO', name: 'Водоканал (демо)' },
    { key: 'tko', type: 'TKO', name: 'Региональный оператор по обращению с ТКО (демо)' },
    { key: 'municipal', type: 'MUNICIPAL', name: 'Администрация района (демо)' },
    { key: 'fund', type: 'CAPREPAIR_FUND', name: 'Региональный оператор капремонта (демо)' },
    { key: 'gzhi', type: 'GZHI', name: 'Госжилинспекция (демо)' },
  ];
  for (const o of orgs) {
    const id = `seed-org-${o.key}`;
    const data = { type: o.type, name: o.name, city: CITY, dataSource: 'synthetic' };
    await db.organization.upsert({ where: { id }, update: data, create: { id, ...data } });
  }
}

async function seedRules() {
  // Единый источник сроков — NORMS: бот и справочник показывают одно и то же.
  const rules: Array<{ category: string; title: string; orgType: string; responseHours: number; normativeRef: string; isEmergency: boolean }> = CATEGORY_ORDER.map((c) => {
    const n = NORMS[c];
    return {
      category: c,
      title: n.title,
      orgType: n.orgType,
      // Рабочие дни храним как календарные часы по верхней оценке (10 р. д. ≈ 14 календарных суток).
      responseHours: n.hours ?? Math.ceil(((n.workingDays ?? 0) * 7) / 5) * 24,
      normativeRef: n.ref,
      isEmergency: !!n.emergency,
    };
  });
  rules.push({
    category: 'gas', title: 'Запах газа', orgType: 'RSO', responseHours: 0,
    normativeRef: 'Заявка через бота не оформляется: звонок в газовую службу 104 или 112', isEmergency: true,
  });
  for (const [i, r] of rules.entries()) {
    await db.responsibleOrg.upsert({
      where: { category: r.category },
      update: { ...r, sortOrder: i },
      create: { ...r, sortOrder: i },
    });
  }
}

async function main() {
  await removeOldDemo();
  const res = await seedHouses();
  await seedServiceOrgs();
  await seedRules();
  const counts = {
    houses: await db.house.count(),
    organizations: await db.organization.count(),
    responsibleOrgs: await db.responsibleOrg.count(),
  };
  console.log('seed: готово', counts);
  if (res.housesRemoved || res.housesKept || res.orgsRemoved) {
    console.log(
      `seed: справочник обновлён — удалено старых домов ${res.housesRemoved}, старых УК ${res.orgsRemoved}` +
        (res.housesKept ? `; оставлено ${res.housesKept} старых домов: к ним привязаны квартиры или заявки` : ''),
    );
  }
  if (res.unverifiedOrgs > 0) {
    console.log(`seed: ${res.unverifiedOrgs} из ${res.orgs} УК помечены «данные уточняются» (не проверены или ИНН не проходит проверку)`);
  }
}

main()
  .catch((err) => {
    console.error('seed: ошибка', err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
