import type { OrgType, RequestCategory } from './enums.js';

/**
 * Нормативные сроки реакции по категориям заявок — единый источник для бота и seed.
 * Каждый срок — со ссылкой на пункт норматива. Сверено 24.09.2026 по текстам:
 *  • Правила № 416 (ПП РФ от 15.05.2013), п. 13 — аварийно-диспетчерское обслуживание; п. 36 — ответ на обращения;
 *  • Правила № 354 (ПП РФ от 06.05.2011), п. 108 — проверка качества коммунальной услуги; прил. 1, п. 17 — вывоз ТКО;
 *  • Правила № 170 (Постановление Госстроя РФ от 27.09.2003), прил. 2 — предельные сроки устранения неисправностей.
 * Где отдельного срока нет — пишем честно и используем общий срок ответа на обращение.
 */

export interface Norm {
  category: RequestCategory;
  title: string;
  orgType: OrgType;
  /** Срок в часах от подачи заявки. */
  hours?: number;
  /** Или в рабочих днях (сб/вс не считаются; праздники — не учитываем). */
  workingDays?: number;
  /** Что именно должно произойти в срок — показывается жильцу. */
  what: string;
  /** Ссылка на норматив — показывается жильцу. */
  ref: string;
  emergency?: boolean;
}

const UTIL_CHECK = 'проверка качества услуги — не позднее 2 часов с момента обращения в аварийно-диспетчерскую службу; аварию устранить — не более чем за 3 суток';
const UTIL_REF = 'п. 108 Правил № 354, п. 13 Правил № 416';

export const NORMS: Record<Exclude<RequestCategory, 'gas'>, Norm> = {
  heating: { category: 'heating', title: 'Отопление', orgType: 'UK', hours: 2, what: UTIL_CHECK, ref: UTIL_REF },
  water: { category: 'water', title: 'Водоснабжение, протечка', orgType: 'UK', hours: 2, what: UTIL_CHECK, ref: UTIL_REF },
  electricity: { category: 'electricity', title: 'Электричество', orgType: 'UK', hours: 2, what: UTIL_CHECK, ref: UTIL_REF },
  sewerage: {
    category: 'sewerage', title: 'Канализация, засор', orgType: 'UK', hours: 2, emergency: true,
    what: 'устранить засор в течение 2 часов с момента регистрации заявки', ref: 'п. 13 Правил № 416',
  },
  roof: {
    category: 'roof', title: 'Крыша, протечка сверху', orgType: 'UK', hours: 24,
    what: 'устранить протечку кровли — 1 сутки', ref: 'прил. 2 к Правилам № 170',
  },
  elevator: {
    category: 'elevator', title: 'Лифт', orgType: 'UK', hours: 24,
    what: 'устранить неисправность лифта — не более 1 суток', ref: 'прил. 2 к Правилам № 170',
  },
  lighting: {
    category: 'lighting', title: 'Свет в подъезде', orgType: 'UK', hours: 24 * 7,
    what: 'восстановить освещение общедомовых помещений — 7 суток', ref: 'прил. 2 к Правилам № 170',
  },
  entrance: {
    category: 'entrance', title: 'Подъезд: двери, окна', orgType: 'UK', hours: 24,
    what: 'входные двери и разбитые стёкла в подъезде — 1 сутки (стёкла летом — 3 суток)', ref: 'прил. 2 к Правилам № 170',
  },
  garbage: {
    category: 'garbage', title: 'Вывоз мусора', orgType: 'TKO', hours: 24,
    what: 'перерыв в вывозе мусора — не более 24 часов подряд (в холодное время — 48 часов)', ref: 'прил. 1 к Правилам № 354, п. 17',
  },
  yard: {
    category: 'yard', title: 'Двор и территория', orgType: 'UK', workingDays: 10,
    what: 'отдельный срок не установлен; ответ на обращение — не более 10 рабочих дней', ref: 'п. 36 Правил № 416',
  },
  other: {
    category: 'other', title: 'Другое', orgType: 'UK', workingDays: 10,
    what: 'ответ на обращение — не более 10 рабочих дней', ref: 'п. 36 Правил № 416',
  },
};

/** Порядок кнопок выбора категории. */
export const CATEGORY_ORDER: Array<keyof typeof NORMS> = [
  'heating', 'water', 'sewerage', 'electricity', 'lighting', 'elevator', 'roof', 'entrance', 'garbage', 'yard', 'other',
];

/** Срок реакции: часы или рабочие дни (по московскому календарю, без праздников). */
export function computeDueAt(norm: Norm, from: Date): Date {
  if (norm.hours !== undefined) return new Date(from.getTime() + norm.hours * 3_600_000);
  let d = new Date(from.getTime());
  let left = norm.workingDays ?? 0;
  while (left > 0) {
    d = new Date(d.getTime() + 24 * 3_600_000);
    const dow = new Date(d.getTime() + 3 * 3_600_000).getUTCDay(); // МСК = UTC+3
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

const MSK = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
/** «25.09, 17:45» по Москве. */
export function formatMsk(d: Date): string {
  return MSK.format(d).replace(',', ',');
}
