import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApartmentInfo, BotStore, HouseInfo, RequestInfo, Session } from '../src/bot/store.js';
import { isValidOrgInn } from '../src/domain/inn.js';

/** Общие для тестов справочник домов (из настоящего файла данных) и in-memory хранилище. */

// ── справочник из настоящего файла данных ───────────────────────────────────
// Постоянный набор из 40 домов (первая версия справочника): сценарии не зависят от того,
// какие дома сейчас в боте. Настоящий справочник проверяет test/reference.test.ts.
const dataFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'houses-sample.json');
const data = JSON.parse(fs.readFileSync(dataFile, 'utf8')) as {
  verified: boolean;
  organizations: Array<{ inn: string; name: string; phone: string; dispatcherPhone: string; workingHours: string }>;
  houses: Array<{ code: string; street: string; houseNumber: string; building: string; district: string; managerInn: string; yearBuilt: number | null; floors: number | null; entrances: number | null; apartmentsCount: number | null }>;
};
export const HOUSES: HouseInfo[] = data.houses.map((h, i) => {
  const o = data.organizations.find((x) => x.inn === h.managerInn);
  return {
    id: `h${i}`, code: h.code, street: h.street, houseNumber: h.houseNumber, building: h.building || null,
    fullAddress: `Казань, ${h.street}, д. ${h.houseNumber}`, district: h.district, yearBuilt: h.yearBuilt,
    floors: h.floors, entrances: h.entrances, apartmentsCount: h.apartmentsCount, verified: data.verified,
    manager: o
      ? { name: o.name, phone: o.phone, dispatcherPhone: o.dispatcherPhone, workingHours: o.workingHours, verified: data.verified && isValidOrgInn(o.inn) }
      : null,
  };
});

// ── in-memory хранилище и запись ответов ────────────────────────────────────
type AptRow = { houseId: string; number: string; entrance: number | null };
type ReqRow = Omit<RequestInfo, 'house' | 'org'> & { user: string; orgType: string; houseId: string; org: RequestInfo['org'] };
const TKO_ORG = { name: 'Региональный оператор по обращению с ТКО (демо)', phone: null, dispatcherPhone: null, workingHours: null, verified: false, demo: true };

export function memoryStore(houses = HOUSES) {
  const sessions = new Map<string, Session>();
  const apartments = new Map<string, AptRow>();
  const requests: ReqRow[] = [];
  let counter = 0;
  const byId = (id: string) => houses.find((h) => h.id === id) ?? null;
  const apt = (u: string): ApartmentInfo | null => {
    const a = apartments.get(u);
    return a ? { number: a.number, entrance: a.entrance, house: byId(a.houseId)! } : null;
  };
  // Как в БД: дом и организация фиксируются при создании, адрес — снимок.
  const view = (r: ReqRow): RequestInfo => {
    const { user: _u, orgType: _o, houseId, ...rest } = r;
    return { ...rest, house: byId(houseId)! };
  };
  const users = new Set<string>();
  const store: BotStore = {
    ensureUser: async (u) => void users.add(u),
    listHouses: async () => houses,
    getHouse: async (id) => byId(id),
    getHouseByCode: async (code) => houses.find((h) => h.code === code) ?? null,
    getSession: async (u) => structuredClone(sessions.get(u) ?? { state: 'idle', data: {} }),
    setSession: async (u, s) => void sessions.set(u, structuredClone(s)),
    getApartment: async (u) => apt(u),
    saveApartment: async (u, a) => void apartments.set(u, { ...a }),
    createRequest: async (u, r) => {
      const a = apt(u);
      if (!a) throw new Error('квартира не привязана');
      const row: ReqRow = {
        id: `r${++counter}`, number: `REQ-2026-${String(counter).padStart(5, '0')}`, user: u, orgType: r.orgType,
        houseId: a.house.id, org: r.orgType === 'UK' ? a.house.manager : TKO_ORG, address: r.address,
        photos: (r.photos ?? []).map((p, i) => ({ ...p, id: `r${counter}p${i}` })),
        category: r.category, description: r.description, status: 'created', createdAt: new Date(clock.now), dueAt: r.dueAt,
        reminderSentAt: null, updatedAt: new Date(clock.now),
      };
      requests.push(row);
      return view(row);
    },
    listRequests: async (u, limit) => requests.filter((r) => r.user === u).reverse().slice(0, limit).map(view),
    getRequest: async (u, id) => {
      const r = requests.find((x) => x.id === id && x.user === u);
      return r ? view(r) : null;
    },
    setRequestStatus: async (u, id, status) => {
      const r = requests.find((x) => x.id === id && x.user === u);
      if (r) (r.status = status), (r.updatedAt = new Date(clock.now));
    },
    cancelRequest: async (u, id) => {
      const r = requests.find((x) => x.id === id && x.user === u);
      if (!r) return 'not_found';
      if (!['created', 'accepted', 'in_progress'].includes(r.status)) return 'closed';
      r.status = 'cancelled';
      r.updatedAt = new Date(clock.now);
      return 'ok';
    },
    overdueRequests: async (q) =>
      requests
        .filter((r) => ['created', 'accepted', 'in_progress'].includes(r.status) && !r.reminderSentAt)
        .filter((r) => (q.createdBefore ? r.createdAt <= q.createdBefore : r.dueAt <= q.now))
        .map((r) => ({ maxUserId: r.user, chatId: 'c1', request: view(r) })),
    setPhotoFile: async (photoId, file) => {
      for (const r of requests) for (const p of r.photos) if (p.id === photoId) p.file = file;
    },
    addPhoto: async (u, id) => {
      const r = requests.find((x) => x.id === id && x.user === u);
      if (!r) return { ok: false, reason: 'not_found' };
      if (!['created', 'accepted', 'in_progress'].includes(r.status)) return { ok: false, reason: 'closed' };
      if (r.photos.length >= 5) return { ok: false, reason: 'limit' };
      const photo = { id: `${r.id}p${r.photos.length}` };
      r.photos.push(photo);
      return { ok: true, id: photo.id };
    },
    getChatId: async () => 'c1',
    houseActivity: async (u, since) => {
      const mine = apartments.get(u);
      if (!mine) return [];
      return requests
        .filter((r) => r.user !== u && r.houseId === mine.houseId && r.createdAt >= since)
        .map((r) => ({ category: r.category, createdAt: r.createdAt }));
    },
    markReminded: async (id, at) => {
      const r = requests.find((x) => x.id === id);
      if (!r || r.reminderSentAt) return false;
      r.reminderSentAt = at;
      return true;
    },
  };
  return Object.assign(store, { apartments, requests, users });
}

/** Управляемые часы: 24.09.2026 12:00 МСК (четверг). */
export const clock = { now: Date.parse('2026-09-24T09:00:00Z') };

