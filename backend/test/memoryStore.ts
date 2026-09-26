import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApartmentInfo, BotStore, ChatAttachment, ChatDigest, ChatMessage, HouseInfo, RequestInfo, Session, UserProfile } from '../src/bot/store.js';
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
  const profiles = new Map<string, UserProfile>();
  type ChatRow = { id: string; houseId: string; user: string; text: string; deleted: boolean; createdAt: Date; attachment: ChatAttachment | null };
  const chat: ChatRow[] = [];
  const chatState = new Map<string, { notify: boolean; lastReadAt: Date | null; lastNotifiedAt: Date | null }>();
  const state = (u: string) => {
    if (!chatState.has(u)) chatState.set(u, { notify: false, lastReadAt: null, lastNotifiedAt: null });
    return chatState.get(u)!;
  };
  // Внутренний ключ автора — не user_id MAX (как users.id в БД).
  const keyOf = (u: string) => `u-${Buffer.from(u).toString('hex')}`;
  const chatView = (m: ChatRow, me: string): ChatMessage => ({
    id: m.id, text: m.deleted ? null : m.text, createdAt: m.createdAt, mine: m.user === me,
    author: { key: keyOf(m.user), name: profiles.get(m.user)?.name ?? null, username: profiles.get(m.user)?.username || null, photoUrl: profiles.get(m.user)?.photoUrl || null },
    attachment: m.deleted ? null : m.attachment,
  });
  const unreadOf = (u: string, since: Date | null) => {
    const a = apartments.get(u);
    if (!a) return [];
    return chat.filter((m) => m.houseId === a.houseId && m.user !== u && !m.deleted && (!since || m.createdAt > since));
  };
  let chatSeq = 0;
  const store: BotStore = {
    ensureUser: async (u, p = {}) => {
      users.add(u);
      const cur = profiles.get(u) ?? {};
      profiles.set(u, { ...cur, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) });
    },
    listHouses: async () => houses,
    getHouse: async (id) => byId(id),
    getHouseByCode: async (code) => houses.find((h) => h.code === code) ?? null,
    getSession: async (u) => structuredClone(sessions.get(u) ?? { state: 'idle', data: {} }),
    setSession: async (u, s) => void sessions.set(u, structuredClone(s)),
    getApartment: async (u) => apt(u),
    saveApartment: async (u, a) => {
      if (apartments.get(u)?.houseId !== a.houseId) Object.assign(state(u), { lastReadAt: new Date(clock.now), lastNotifiedAt: null });
      apartments.set(u, { ...a });
    },
    createRequest: async (u, r) => {
      const a = apt(u);
      if (!a) throw new Error('квартира не привязана');
      const row: ReqRow = {
        id: `r${++counter}`, number: `REQ-2026-${String(counter).padStart(5, '0')}`, user: u, orgType: r.orgType,
        houseId: a.house.id, org: r.orgType === 'UK' ? a.house.manager : TKO_ORG, address: r.address,
        photos: (r.photos ?? []).map((p, i) => ({ ...p, id: `r${counter}p${i}` })),
        category: r.category, description: r.description, status: 'created', createdAt: new Date(clock.now), dueAt: r.dueAt,
        reminderSentAt: null, updatedAt: new Date(clock.now), rating: null,
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
    rateRequest: async (u, id, r, at) => {
      const x = requests.find((y) => y.id === id && y.user === u);
      if (!x) return 'not_found';
      if (x.rating) return 'already';
      if (x.status !== 'completed') return 'not_completed';
      x.rating = { value: r.value, comment: r.comment, at };
      return 'ok';
    },
    ukRating: async (u) => {
      const mine = apt(u);
      const rated = requests.filter((r) => mine?.house.manager && r.org === mine.house.manager && r.rating);
      return rated.length ? { avg: rated.reduce((s, r) => s + r.rating!.value, 0) / rated.length, count: rated.length } : null;
    },
    chatView: async (u, opts) => {
      const a = apartments.get(u);
      if (!a) return null;
      const all = chat.filter((m) => m.houseId === a.houseId && (!opts.before || m.createdAt < opts.before));
      const page = all.slice(-opts.limit);
      return {
        houseId: a.houseId,
        members: [...apartments.values()].filter((x) => x.houseId === a.houseId).length,
        messages: page.map((m) => chatView(m, u)),
        hasMore: all.length > page.length,
        notify: state(u).notify,
        lastReadAt: state(u).lastReadAt,
        othersReadAt: [...chatState.entries()]
          .filter(([x]) => x !== u && apartments.get(x)?.houseId === a.houseId)
          .map(([, st]) => st.lastReadAt)
          .reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null),
      };
    },
    postChat: async (u, msg, at) => {
      const a = apartments.get(u);
      if (!a) return null;
      const m = { id: msg.id ?? `m${++chatSeq}`, houseId: a.houseId, user: u, text: msg.text, deleted: false, createdAt: at, attachment: msg.attachment ?? null };
      chat.push(m);
      state(u).lastReadAt = at;
      return chatView(m, u);
    },
    deleteChat: async (u, id) => {
      const m = chat.find((x) => x.id === id && x.user === u && !x.deleted);
      if (!m) return { ok: false, file: null };
      m.deleted = true;
      m.text = '';
      const file = m.attachment?.file ?? null;
      m.attachment = null;
      return { ok: true, file };
    },
    chatAttachment: async (id) => chat.find((x) => x.id === id && !x.deleted)?.attachment ?? null,
    setChatNotify: async (u, on) => {
      state(u).notify = on;
      if (on) state(u).lastNotifiedAt = new Date(clock.now);
    },
    markChatRead: async (u, at) => void (state(u).lastReadAt = at),
    chatUnread: async (u) => unreadOf(u, state(u).lastReadAt).length,
    chatDigests: async (now, quietMs) => {
      const out: ChatDigest[] = [];
      for (const [u, s] of chatState) {
        if (!s.notify || (s.lastNotifiedAt && now.getTime() - s.lastNotifiedAt.getTime() < quietMs)) continue;
        const since = [s.lastReadAt, s.lastNotifiedAt].filter((d): d is Date => !!d).reduce<Date | null>((a, b) => (!a || b > a ? b : a), null);
        const fresh = unreadOf(u, since);
        const last = fresh.at(-1);
        if (last) {
          out.push({
            maxUserId: u, chatId: 'c1', count: fresh.length,
            last: { name: profiles.get(last.user)?.name ?? null, text: last.text, kind: last.attachment?.kind ?? 'text', fileName: last.attachment?.name ?? null, duration: last.attachment?.duration ?? null },
          });
        }
      }
      return out;
    },
    markChatNotified: async (u, at) => void (state(u).lastNotifiedAt = at),
    markReminded: async (id, at) => {
      const r = requests.find((x) => x.id === id);
      if (!r || r.reminderSentAt) return false;
      r.reminderSentAt = at;
      return true;
    },
  };
  return Object.assign(store, { apartments, requests, users, profiles, chat, chatState });
}

/** Управляемые часы: 24.09.2026 12:00 МСК (четверг). */
export const clock = { now: Date.parse('2026-09-24T09:00:00Z') };

