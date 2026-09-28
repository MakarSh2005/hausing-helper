import type { Db } from '../db.js';
import { formatAddress } from '../domain/address.js';
import { decodeRef, encodeRef, MAX_PHOTOS, type PhotoRef, type StoredPhoto } from '../domain/photos.js';
import type { OrgType, RequestCategory, RequestStatus } from '../domain/enums.js';

/**
 * Всё, что сценариям бота нужно от хранилища. Отдельный интерфейс — чтобы сценарии
 * тестировались без БД (in-memory реализация в тестах) и не знали о Prisma.
 */

export interface OrgInfo {
  name: string;
  phone: string | null;
  dispatcherPhone: string | null;
  workingHours: string | null;
  /** false — данные не проверены: бот не показывает телефоны и пишет «данные уточняются». */
  verified: boolean;
  /** Синтетическая организация для демо: в названии уже есть «(демо)». */
  demo?: boolean;
}

export interface HouseInfo {
  id: string;
  code: string;
  street: string;
  houseNumber: string;
  building: string | null;
  fullAddress: string;
  district: string | null;
  yearBuilt: number | null;
  floors: number | null;
  entrances: number | null;
  apartmentsCount: number | null;
  verified: boolean;
  manager: OrgInfo | null;
}

export interface ApartmentInfo {
  number: string;
  entrance: number | null;
  house: HouseInfo;
}

export interface Session {
  state: string;
  data: SessionData;
}

export interface SessionData {
  houseId?: string;
  apartment?: string;
  /** Описание проблемы, которое жилец прислал до привязки квартиры или в ходе оформления. */
  pending?: string;
  /** Категория в оформляемой заявке. */
  category?: RequestCategory;
  /** Фото, присланные в ходе оформления (до MAX_PHOTOS). */
  photos?: PhotoRef[];
}

export interface RequestInfo {
  id: string;
  number: string;
  category: RequestCategory;
  description: string;
  /** Сохранённый статус; отображаемый считает effectiveStatus(). */
  status: RequestStatus;
  createdAt: Date;
  dueAt: Date;
  reminderSentAt: Date | null;
  /** Время последнего изменения: для закрытых заявок — когда закрыли. */
  updatedAt: Date;
  org: OrgInfo | null;
  /** Адрес на момент подачи: «ул. Баумана, д. 15, кв. 42, подъезд 2». */
  address: string;
  /** Дом заявки (не меняется при перепривязке квартиры). */
  house: HouseInfo;
  photos: StoredPhoto[];
  /** Оценка жильца после закрытия; null — ещё не оценена. */
  rating: RatingInfo | null;
}

export interface RatingInfo {
  value: number;
  comment: string | null;
  at: Date;
}

/** Профиль MAX: имя, публичный ник (если задан) и фото — из данных запуска мини-приложения. */
export interface UserProfile {
  name?: string;
  username?: string;
  photoUrl?: string;
}

/** Чат дома в MAX: групповой чат, привязанный к дому (создаёт человек, бот привязывает командой /дом). */
export interface HouseChatInfo {
  houseId: string;
  chatId: string;
  title: string | null;
  /** Ссылка-приглашение в чат; null — бот её не получил. */
  link: string | null;
  createdAt: Date;
}

export interface NewRequest {
  /** Снимок адреса квартиры на момент подачи. */
  address: string;
  category: RequestCategory;
  description: string;
  orgType: OrgType;
  dueAt: Date;
  photos?: PhotoRef[];
}

export interface OverdueQuery {
  now: Date;
  /** Демо: напоминать по заявкам, созданным раньше этого момента, а не по dueAt. */
  createdBefore?: Date;
  limit?: number;
}

export interface BotStore {
  /** Создать пользователя, если его ещё нет (вход в мини-приложение раньше первого сообщения боту). */
  ensureUser(maxUserId: string, profile?: UserProfile): Promise<void>;
  listHouses(): Promise<HouseInfo[]>;
  getHouse(id: string): Promise<HouseInfo | null>;
  getHouseByCode(code: string): Promise<HouseInfo | null>;
  getSession(maxUserId: string): Promise<Session>;
  setSession(maxUserId: string, session: Session): Promise<void>;
  getApartment(maxUserId: string): Promise<ApartmentInfo | null>;
  saveApartment(maxUserId: string, a: { houseId: string; number: string; entrance: number | null }): Promise<void>;

  /** Создаёт заявку на привязанную квартиру: номер REQ-ГГГГ-NNNNN, ответственная организация по типу. */
  createRequest(maxUserId: string, r: NewRequest): Promise<RequestInfo>;
  /** Заявки жильца, новые сверху. */
  listRequests(maxUserId: string, limit: number): Promise<RequestInfo[]>;
  /** Только своя заявка: чужая просто не находится. */
  getRequest(maxUserId: string, id: string): Promise<RequestInfo | null>;
  setRequestStatus(maxUserId: string, id: string, status: RequestStatus): Promise<void>;
  /**
   * Отзыв жильцом: только своя и только открытая заявка, одной атомарной операцией.
   * closed — заявка уже закрыта (решена, отклонена или отозвана раньше).
   */
  cancelRequest(maxUserId: string, id: string): Promise<'ok' | 'not_found' | 'closed'>;
  /** Открытые заявки с истёкшим сроком, по которым ещё не напоминали. */
  overdueRequests(q: OverdueQuery): Promise<Array<{ maxUserId: string; chatId: string | null; request: RequestInfo }>>;
  /** true — отметили мы (защита от двойного напоминания при параллельных запусках). */
  markReminded(id: string, at: Date): Promise<boolean>;
  /** Файл фото скачан на диск. */
  setPhotoFile(photoId: string, file: string): Promise<void>;
  /**
   * Добавить фото к своей открытой заявке (загрузка из мини-приложения). Лимит — MAX_PHOTOS.
   * Возвращает id вложения — под ним затем сохраняется файл.
   */
  addPhoto(maxUserId: string, requestId: string): Promise<{ ok: true; id: string } | { ok: false; reason: 'not_found' | 'closed' | 'limit' }>;
  /**
   * Заявки соседей по дому жильца за период — только категория и время, без текста и квартиры
   * (для «Соседи уже сообщили»). Свои заявки не включаются.
   */
  houseActivity(maxUserId: string, since: Date): Promise<Array<{ category: RequestCategory; createdAt: Date }>>;
  /** chat_id диалога с пользователем — чтобы бот мог написать первым. */
  getChatId(maxUserId: string): Promise<string | null>;

  /** Оценка своей заявки: только выполненной и только один раз. */
  rateRequest(maxUserId: string, id: string, r: { value: number; comment: string | null }, at: Date): Promise<'ok' | 'not_found' | 'not_completed' | 'already'>;
  /** Средняя оценка УК текущего дома жильца по всем оценённым заявкам; null — оценок нет. */
  ukRating(maxUserId: string): Promise<{ avg: number; count: number } | null>;

  /** Чат дома в MAX для дома жильца; null — квартира не привязана или чата нет. */
  houseChat(maxUserId: string): Promise<HouseChatInfo | null>;
  houseChatByChat(chatId: string): Promise<HouseChatInfo | null>;
  houseChatByHouse(houseId: string): Promise<HouseChatInfo | null>;
  /** Привязать групповой чат к дому. Один чат — один дом; у дома — один чат (новый заменяет старый). */
  bindHouseChat(c: { houseId: string; chatId: string; title: string | null; link: string | null; boundBy: string }): Promise<void>;
  unbindHouseChat(chatId: string): Promise<boolean>;
}

export const IDLE: Session = { state: 'idle', data: {} };

// ─── Prisma ──────────────────────────────────────────────────────────────────

const houseInclude = { manager: true } as const;
const requestInclude = {
  organization: true,
  house: { include: houseInclude },
  apartment: true,
  attachments: { orderBy: { createdAt: 'asc' } },
} as const;
const OPEN: RequestStatus[] = ['created', 'accepted', 'in_progress'];

type OrgRow = { name: string; phone: string | null; dispatcherPhone: string | null; workingHours: string | null; dataSource: string };

type HouseRow = {
  id: string; code: string; street: string; houseNumber: string; building: string | null; fullAddress: string;
  district: string | null; yearBuilt: number | null; floors: number | null; entrances: number | null;
  apartmentsCount: number | null; dataSource: string;
  manager: OrgRow | null;
};

type RequestRow = {
  id: string; number: string; category: string; description: string; status: string;
  createdAt: Date; dueAt: Date; reminderSentAt: Date | null; updatedAt: Date;
  address: string | null;
  rating: number | null; ratingComment: string | null; ratedAt: Date | null;
  organization: OrgRow | null;
  house: HouseRow;
  apartment: { number: string; entrance: number | null };
  attachments: Array<{ id: string; type: string; ref: string }>;
};

const isVerified = (dataSource: string) => dataSource === 'gis_zhkh' || dataSource === 'open_data';

function toOrg(o: OrgRow): OrgInfo {
  return {
    name: o.name, phone: o.phone, dispatcherPhone: o.dispatcherPhone, workingHours: o.workingHours,
    verified: isVerified(o.dataSource), demo: o.dataSource === 'synthetic',
  };
}

function toRequest(r: RequestRow): RequestInfo {
  return {
    id: r.id, number: r.number, category: r.category as RequestCategory, description: r.description,
    status: r.status as RequestStatus, createdAt: r.createdAt, dueAt: r.dueAt, reminderSentAt: r.reminderSentAt, updatedAt: r.updatedAt,
    org: r.organization ? toOrg(r.organization) : null,
    house: toHouse(r.house),
    photos: r.attachments.filter((a) => a.type === 'image').map((a) => decodeRef(a.id, a.ref)),
    // Заявки до появления снимка адреса: собираем из дома заявки и текущего номера квартиры.
    address: r.address ?? `${formatAddress(r.house)}, кв. ${r.apartment.number}`,
    rating: r.rating != null && r.ratedAt ? { value: r.rating, comment: r.ratingComment, at: r.ratedAt } : null,
  };
}

function toHouse(h: HouseRow): HouseInfo {
  return {
    id: h.id, code: h.code, street: h.street, houseNumber: h.houseNumber, building: h.building,
    fullAddress: h.fullAddress, district: h.district, yearBuilt: h.yearBuilt, floors: h.floors,
    entrances: h.entrances, apartmentsCount: h.apartmentsCount,
    verified: isVerified(h.dataSource),
    manager: h.manager ? toOrg(h.manager) : null,
  };
}

function parseData(raw: string): SessionData {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as SessionData) : {};
  } catch {
    return {};
  }
}

export function createPrismaStore(db: Db, opts: { cacheMs?: number } = {}): BotStore {
  const cacheMs = opts.cacheMs ?? 5 * 60_000;
  let cache: { at: number; houses: HouseInfo[] } | undefined;

  const userId = async (maxUserId: string) => {
    const u = await db.user.findUnique({ where: { maxUserId }, select: { id: true } });
    if (!u) throw new Error(`пользователь ${maxUserId} не найден`);
    return u.id;
  };

  return {
    async ensureUser(maxUserId, p = {}) {
      // Профиль обновляем при каждом входе: жилец мог сменить имя или фото в MAX.
      const profile = {
        ...(p.name ? { name: p.name } : {}),
        ...(p.username !== undefined ? { username: p.username || null } : {}),
        ...(p.photoUrl !== undefined ? { photoUrl: p.photoUrl || null } : {}),
      };
      await db.user.upsert({
        where: { maxUserId },
        create: { maxUserId, name: p.name ?? null, username: p.username ?? null, photoUrl: p.photoUrl ?? null },
        update: { lastSeenAt: new Date(), ...profile },
      });
    },
    async listHouses() {
      if (cache && Date.now() - cache.at < cacheMs) return cache.houses;
      const rows = (await db.house.findMany({ include: houseInclude })) as unknown as HouseRow[];
      cache = { at: Date.now(), houses: rows.map(toHouse) };
      return cache.houses;
    },
    async getHouse(id) {
      const h = (await db.house.findUnique({ where: { id }, include: houseInclude })) as unknown as HouseRow | null;
      return h ? toHouse(h) : null;
    },
    async getHouseByCode(code) {
      const h = (await db.house.findUnique({ where: { code }, include: houseInclude })) as unknown as HouseRow | null;
      return h ? toHouse(h) : null;
    },
    async getSession(maxUserId) {
      const s = await db.userSession.findUnique({ where: { userId: await userId(maxUserId) } });
      return s ? { state: s.state, data: parseData(s.data) } : { ...IDLE, data: {} };
    },
    async setSession(maxUserId, session) {
      const id = await userId(maxUserId);
      const data = JSON.stringify(session.data);
      await db.userSession.upsert({
        where: { userId: id },
        create: { userId: id, state: session.state, data },
        update: { state: session.state, data },
      });
    },
    async getApartment(maxUserId) {
      const a = (await db.apartment.findUnique({
        where: { userId: await userId(maxUserId) },
        include: { house: { include: houseInclude } },
      })) as unknown as { number: string; entrance: number | null; house: HouseRow } | null;
      return a ? { number: a.number, entrance: a.entrance, house: toHouse(a.house) } : null;
    },
    async saveApartment(maxUserId, a) {
      const id = await userId(maxUserId);
      await db.apartment.upsert({
        where: { userId: id },
        create: { userId: id, houseId: a.houseId, number: a.number, entrance: a.entrance },
        update: { houseId: a.houseId, number: a.number, entrance: a.entrance, floor: null },
      });
    },

    async createRequest(maxUserId, r) {
      const id = await userId(maxUserId);
      const apt = await db.apartment.findUnique({ where: { userId: id }, include: { house: true } });
      if (!apt) throw new Error('квартира не привязана');
      // УК — из справочника дома; остальные — первая организация нужного типа (демо-справочник).
      const organizationId =
        r.orgType === 'UK'
          ? apt.house.managerId
          : ((await db.organization.findFirst({ where: { type: r.orgType }, orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id ?? null);
      const year = new Date().getUTCFullYear();
      const created = await db.$transaction(async (tx) => {
        const c = await tx.requestCounter.upsert({
          where: { year },
          create: { year, value: 1 },
          update: { value: { increment: 1 } },
        });
        return tx.request.create({
          data: {
            number: `REQ-${year}-${String(c.value).padStart(5, '0')}`,
            userId: id, apartmentId: apt.id, houseId: apt.houseId,
            category: r.category, description: r.description, address: r.address, orgType: r.orgType, organizationId,
            dueAt: r.dueAt,
            attachments: { create: (r.photos ?? []).map((p) => ({ type: 'image', ref: encodeRef(p) })) },
          },
          include: requestInclude,
        });
      });
      return toRequest(created as unknown as RequestRow);
    },
    async listRequests(maxUserId, limit) {
      const rows = await db.request.findMany({
        where: { userId: await userId(maxUserId) },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: requestInclude,
      });
      return (rows as unknown as RequestRow[]).map(toRequest);
    },
    async getRequest(maxUserId, id) {
      const r = await db.request.findFirst({ where: { id, userId: await userId(maxUserId) }, include: requestInclude });
      return r ? toRequest(r as unknown as RequestRow) : null;
    },
    async setRequestStatus(maxUserId, id, status) {
      await db.request.updateMany({ where: { id, userId: await userId(maxUserId) }, data: { status } });
    },
    async cancelRequest(maxUserId, id) {
      const userId_ = await userId(maxUserId);
      const res = await db.request.updateMany({ where: { id, userId: userId_, status: { in: OPEN } }, data: { status: 'cancelled' } });
      if (res.count === 1) return 'ok';
      const exists = await db.request.findFirst({ where: { id, userId: userId_ }, select: { id: true } });
      return exists ? 'closed' : 'not_found';
    },
    async overdueRequests(q) {
      const rows = await db.request.findMany({
        where: {
          status: { in: OPEN },
          reminderSentAt: null,
          ...(q.createdBefore ? { createdAt: { lte: q.createdBefore } } : { dueAt: { lte: q.now } }),
        },
        orderBy: { dueAt: 'asc' },
        take: q.limit ?? 50,
        include: { ...requestInclude, user: { select: { maxUserId: true, maxChatId: true } } },
      });
      return rows.map((r) => ({
        maxUserId: r.user.maxUserId,
        chatId: r.user.maxChatId,
        request: toRequest(r as unknown as RequestRow),
      }));
    },
    async setPhotoFile(photoId, file) {
      const a = await db.requestAttachment.findUnique({ where: { id: photoId } });
      if (!a) return;
      await db.requestAttachment.update({ where: { id: photoId }, data: { ref: encodeRef({ ...decodeRef(a.id, a.ref), file }) } });
    },
    async addPhoto(maxUserId, requestId) {
      const r = await db.request.findFirst({
        where: { id: requestId, userId: await userId(maxUserId) },
        select: { status: true, _count: { select: { attachments: true } } },
      });
      if (!r) return { ok: false, reason: 'not_found' };
      if (!OPEN.includes(r.status as RequestStatus)) return { ok: false, reason: 'closed' };
      if (r._count.attachments >= MAX_PHOTOS) return { ok: false, reason: 'limit' };
      const a = await db.requestAttachment.create({ data: { requestId, type: 'image', ref: encodeRef({}) } });
      return { ok: true, id: a.id };
    },
    async houseActivity(maxUserId, since) {
      const id = await userId(maxUserId);
      const apt = await db.apartment.findUnique({ where: { userId: id }, select: { houseId: true } });
      if (!apt) return [];
      const rows = await db.request.findMany({
        where: { houseId: apt.houseId, userId: { not: id }, createdAt: { gte: since } },
        select: { category: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      return rows.map((r) => ({ category: r.category as RequestCategory, createdAt: r.createdAt }));
    },
    async getChatId(maxUserId) {
      const u = await db.user.findUnique({ where: { maxUserId }, select: { maxChatId: true } });
      return u?.maxChatId ?? null;
    },
    async markReminded(id, at) {
      const res = await db.request.updateMany({ where: { id, reminderSentAt: null }, data: { reminderSentAt: at } });
      return res.count === 1;
    },

    async rateRequest(maxUserId, id, r, at) {
      const uid = await userId(maxUserId);
      const x = await db.request.findFirst({ where: { id, userId: uid }, select: { status: true, rating: true, updatedAt: true } });
      if (!x) return 'not_found';
      if (x.rating != null) return 'already';
      if (x.status !== 'completed') return 'not_completed';
      // updatedAt — время закрытия (по нему строится хронология), оценка его не сдвигает.
      // Условие rating: null — в самом запросе: две оценки подряд не перезапишут друг друга.
      const res = await db.request.updateMany({
        where: { id, userId: uid, status: 'completed', rating: null },
        data: { rating: r.value, ratingComment: r.comment, ratedAt: at, updatedAt: x.updatedAt },
      });
      return res.count === 1 ? 'ok' : 'already';
    },
    async ukRating(maxUserId) {
      const apt = await db.apartment.findUnique({ where: { userId: await userId(maxUserId) }, select: { house: { select: { managerId: true } } } });
      const orgId = apt?.house.managerId;
      if (!orgId) return null;
      const agg = await db.request.aggregate({ where: { organizationId: orgId, rating: { not: null } }, _avg: { rating: true }, _count: { rating: true } });
      return agg._count.rating ? { avg: agg._avg.rating ?? 0, count: agg._count.rating } : null;
    },

    async houseChat(maxUserId) {
      const apt = await db.apartment.findUnique({ where: { userId: await userId(maxUserId) }, select: { houseId: true } });
      if (!apt) return null;
      const c = await db.houseChat.findUnique({ where: { houseId: apt.houseId } });
      return c ? toHouseChat(c) : null;
    },
    async houseChatByHouse(houseId) {
      const c = await db.houseChat.findUnique({ where: { houseId } });
      return c ? toHouseChat(c) : null;
    },
    async houseChatByChat(chatId) {
      const c = await db.houseChat.findUnique({ where: { chatId } });
      return c ? toHouseChat(c) : null;
    },
    async bindHouseChat(c) {
      await db.$transaction([
        // Чат переезжает к другому дому или у дома новый чат — старые привязки убираем
        db.houseChat.deleteMany({ where: { OR: [{ chatId: c.chatId }, { houseId: c.houseId }] } }),
        db.houseChat.create({ data: { houseId: c.houseId, chatId: c.chatId, title: c.title, link: c.link, boundByMaxUserId: c.boundBy } }),
      ]);
    },
    async unbindHouseChat(chatId) {
      const r = await db.houseChat.deleteMany({ where: { chatId } });
      return r.count > 0;
    },
  };
}

function toHouseChat(c: { houseId: string; chatId: string; title: string | null; link: string | null; createdAt: Date }): HouseChatInfo {
  return { houseId: c.houseId, chatId: c.chatId, title: c.title, link: c.link, createdAt: c.createdAt };
}
