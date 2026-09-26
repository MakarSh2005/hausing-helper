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

/** Автор сообщения в чате дома. key — внутренний id, не user_id MAX: его соседям не отдаём. */
export interface ChatAuthor {
  key: string;
  name: string | null;
  username: string | null;
  photoUrl: string | null;
}

export type ChatKind = 'text' | 'photo' | 'voice' | 'file';

export interface ChatAttachment {
  kind: Exclude<ChatKind, 'text'>;
  /** Имя файла на диске. */
  file: string;
  name: string | null;
  size: number;
  mime: string;
  duration: number | null;
}

export interface ChatMessage {
  id: string;
  /** null — сообщение удалено автором. У вложения без подписи — пустая строка. */
  text: string | null;
  createdAt: Date;
  author: ChatAuthor;
  mine: boolean;
  /** null — обычное текстовое или удалённое. */
  attachment: ChatAttachment | null;
}

export interface ChatView {
  houseId: string;
  /** Сколько жильцов с привязанной квартирой в доме — все они участники чата. */
  members: number;
  /** Старые сверху. */
  messages: ChatMessage[];
  /** Есть сообщения раньше самого старого из messages. */
  hasMore: boolean;
  notify: boolean;
  lastReadAt: Date | null;
  /** До какого момента чат прочитан хотя бы одним соседом — для галочек «прочитано» у своих сообщений. */
  othersReadAt: Date | null;
}

/** Сводка для уведомления ботом: новые сообщения соседей с прошлого прочтения или прошлой сводки. */
export interface ChatDigest {
  maxUserId: string;
  chatId: string;
  count: number;
  last: { name: string | null; text: string; kind: ChatKind; fileName: string | null; duration: number | null };
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

  /** Чат дома жильца; null — квартира не привязана. */
  chatView(maxUserId: string, opts: { limit: number; before?: Date }): Promise<ChatView | null>;
  /** null — квартира не привязана. id — заранее (файл вложения уже сохранён под этим именем). */
  postChat(maxUserId: string, msg: { text: string; id?: string; attachment?: ChatAttachment }, at: Date): Promise<ChatMessage | null>;
  /** Удалить своё сообщение: текст стирается, file — вложение, которое нужно удалить с диска. */
  deleteChat(maxUserId: string, id: string, at: Date): Promise<{ ok: boolean; file: string | null }>;
  /** Вложение сообщения — для выдачи по подписанной ссылке. null — нет, удалено или без вложения. */
  chatAttachment(id: string): Promise<ChatAttachment | null>;
  setChatNotify(maxUserId: string, on: boolean): Promise<void>;
  markChatRead(maxUserId: string, at: Date): Promise<void>;
  /** Непрочитанные сообщения соседей в чате своего дома. */
  chatUnread(maxUserId: string): Promise<number>;
  /** Кому пора прислать сводку: уведомления включены, есть новое, прошлая сводка была раньше quietMs. */
  chatDigests(now: Date, quietMs: number): Promise<ChatDigest[]>;
  markChatNotified(maxUserId: string, at: Date): Promise<void>;
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
      const prev = await db.apartment.findUnique({ where: { userId: id }, select: { houseId: true } });
      // Новый дом — новый чат: всё, что написано до вступления, считаем прочитанным.
      if (prev?.houseId !== a.houseId) {
        const now = new Date();
        await db.houseChatState.upsert({ where: { userId: id }, create: { userId: id, lastReadAt: now }, update: { lastReadAt: now, lastNotifiedAt: null } });
      }
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

    async chatView(maxUserId, opts) {
      const uid = await userId(maxUserId);
      const apt = await db.apartment.findUnique({ where: { userId: uid }, select: { houseId: true } });
      if (!apt) return null;
      const [rows, members, state, others] = await Promise.all([
        db.houseChatMessage.findMany({
          where: { houseId: apt.houseId, ...(opts.before ? { createdAt: { lt: opts.before } } : {}) },
          orderBy: { createdAt: 'desc' },
          take: opts.limit + 1,
          include: { user: { select: { id: true, name: true, username: true, photoUrl: true } } },
        }),
        db.apartment.count({ where: { houseId: apt.houseId } }),
        db.houseChatState.findUnique({ where: { userId: uid } }),
        db.houseChatState.aggregate({
          where: { userId: { not: uid }, user: { is: { apartment: { is: { houseId: apt.houseId } } } } },
          _max: { lastReadAt: true },
        }),
      ]);
      return {
        othersReadAt: others._max.lastReadAt ?? null,
        houseId: apt.houseId,
        members,
        hasMore: rows.length > opts.limit,
        messages: rows.slice(0, opts.limit).reverse().map((m) => toChatMessage(m, uid)),
        notify: state?.notify ?? false,
        lastReadAt: state?.lastReadAt ?? null,
      };
    },
    async postChat(maxUserId, msg, at) {
      const uid = await userId(maxUserId);
      const apt = await db.apartment.findUnique({ where: { userId: uid }, select: { houseId: true } });
      if (!apt) return null;
      const a = msg.attachment;
      const m = await db.houseChatMessage.create({
        data: {
          ...(msg.id ? { id: msg.id } : {}),
          houseId: apt.houseId, userId: uid, text: msg.text, createdAt: at,
          ...(a ? { kind: a.kind, file: a.file, fileName: a.name, fileSize: a.size, mime: a.mime, duration: a.duration } : {}),
        },
        include: { user: { select: { id: true, name: true, username: true, photoUrl: true } } },
      });
      // Своё сообщение — прочитано.
      await db.houseChatState.upsert({ where: { userId: uid }, create: { userId: uid, lastReadAt: at }, update: { lastReadAt: at } });
      return toChatMessage(m, uid);
    },
    async deleteChat(maxUserId, id, at) {
      const uid = await userId(maxUserId);
      const m = await db.houseChatMessage.findFirst({ where: { id, userId: uid, deletedAt: null }, select: { file: true } });
      if (!m) return { ok: false, file: null };
      const res = await db.houseChatMessage.updateMany({
        where: { id, userId: uid, deletedAt: null },
        data: { deletedAt: at, text: '', file: null, fileName: null },
      });
      return { ok: res.count === 1, file: res.count === 1 ? m.file : null };
    },
    async chatAttachment(id) {
      const m = await db.houseChatMessage.findUnique({ where: { id } });
      return m && !m.deletedAt ? toAttachment(m) : null;
    },
    async setChatNotify(maxUserId, on) {
      const uid = await userId(maxUserId);
      // Включили — считаем от этого момента, чтобы не прислать сводку по старым сообщениям.
      await db.houseChatState.upsert({
        where: { userId: uid },
        create: { userId: uid, notify: on, lastNotifiedAt: new Date() },
        update: { notify: on, ...(on ? { lastNotifiedAt: new Date() } : {}) },
      });
    },
    async markChatRead(maxUserId, at) {
      const uid = await userId(maxUserId);
      await db.houseChatState.upsert({ where: { userId: uid }, create: { userId: uid, lastReadAt: at }, update: { lastReadAt: at } });
    },
    async chatUnread(maxUserId) {
      const uid = await userId(maxUserId);
      const [apt, state] = await Promise.all([
        db.apartment.findUnique({ where: { userId: uid }, select: { houseId: true, createdAt: true } }),
        db.houseChatState.findUnique({ where: { userId: uid }, select: { lastReadAt: true } }),
      ]);
      if (!apt) return 0;
      return db.houseChatMessage.count({
        where: { houseId: apt.houseId, userId: { not: uid }, deletedAt: null, createdAt: { gt: state?.lastReadAt ?? apt.createdAt } },
      });
    },
    async chatDigests(now, quietMs) {
      const states = await db.houseChatState.findMany({
        where: { notify: true, OR: [{ lastNotifiedAt: null }, { lastNotifiedAt: { lte: new Date(now.getTime() - quietMs) } }] },
        include: { user: { select: { maxUserId: true, maxChatId: true, apartment: { select: { houseId: true, createdAt: true } } } } },
        take: 200,
      });
      const out: ChatDigest[] = [];
      for (const s of states) {
        const apt = s.user.apartment;
        if (!apt || !s.user.maxChatId) continue;
        const since = [s.lastReadAt, s.lastNotifiedAt, apt.createdAt].filter((d): d is Date => !!d).reduce((a, b) => (a > b ? a : b));
        const where = { houseId: apt.houseId, userId: { not: s.userId }, deletedAt: null, createdAt: { gt: since } };
        const [count, last] = await Promise.all([
          db.houseChatMessage.count({ where }),
          db.houseChatMessage.findFirst({ where, orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } }),
        ]);
        if (count && last) {
          out.push({
            maxUserId: s.user.maxUserId, chatId: s.user.maxChatId, count,
            last: { name: last.user.name, text: last.text, kind: last.kind as ChatKind, fileName: last.fileName, duration: last.duration },
          });
        }
      }
      return out;
    },
    async markChatNotified(maxUserId, at) {
      const uid = await userId(maxUserId);
      await db.houseChatState.updateMany({ where: { userId: uid }, data: { lastNotifiedAt: at } });
    },
  };
}

type AttachmentRow = { kind: string; file: string | null; fileName: string | null; fileSize: number | null; mime: string | null; duration: number | null };
type ChatRow = AttachmentRow & {
  id: string; text: string; deletedAt: Date | null; createdAt: Date;
  user: { id: string; name: string | null; username: string | null; photoUrl: string | null };
};

function toAttachment(m: AttachmentRow): ChatAttachment | null {
  if (m.kind === 'text' || !m.file || !m.mime) return null;
  return { kind: m.kind as ChatAttachment['kind'], file: m.file, name: m.fileName, size: m.fileSize ?? 0, mime: m.mime, duration: m.duration };
}

function toChatMessage(m: ChatRow, me: string): ChatMessage {
  return {
    id: m.id,
    text: m.deletedAt ? null : m.text,
    createdAt: m.createdAt,
    mine: m.user.id === me,
    author: { key: m.user.id, name: m.user.name, username: m.user.username, photoUrl: m.user.photoUrl },
    attachment: m.deletedAt ? null : toAttachment(m),
  };
}
