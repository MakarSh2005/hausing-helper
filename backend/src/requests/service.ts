import type { BotStore, RequestInfo } from '../bot/store.js';
import { formatAddress } from '../domain/address.js';
import { detectCategory } from '../domain/category.js';
import { RequestCategory } from '../domain/enums.js';
import { computeDueAt, NORMS } from '../domain/norms.js';

/**
 * Подача заявки — одна логика для мини-приложения (и любого будущего канала):
 * адрес берётся из привязанной квартиры, срок и ответственный — из NORMS.
 */

export const MIN_DESCRIPTION = 5;
export const MAX_DESCRIPTION = 1000;
/** Повторная отправка того же текста в течение этого окна возвращает уже созданную заявку. */
const DUPLICATE_WINDOW_MS = 2 * 60_000;

export type SubmitResult =
  | { ok: true; request: RequestInfo; duplicate: boolean }
  | { ok: false; reason: 'no_apartment' | 'too_short' | 'bad_category' | 'gas' };

export function cleanDescription(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
}

/** Категория по описанию: для превью в мини-приложении. */
export function suggestCategory(text: string): RequestCategory | null {
  return detectCategory(cleanDescription(text));
}

export async function submitRequest(
  store: BotStore,
  maxUserId: string,
  input: { description: string; category: string },
  now: Date,
): Promise<SubmitResult> {
  const description = cleanDescription(input.description);
  if (description.replace(/\s/g, '').length < MIN_DESCRIPTION) return { ok: false, reason: 'too_short' };
  // Запах газа — не заявка, а звонок 104/112, даже если категорию выбрали вручную.
  if (input.category === 'gas' || detectCategory(description) === 'gas') return { ok: false, reason: 'gas' };
  const cat = RequestCategory.safeParse(input.category);
  if (!cat.success || cat.data === 'gas') return { ok: false, reason: 'bad_category' };
  const apt = await store.getApartment(maxUserId);
  if (!apt) return { ok: false, reason: 'no_apartment' };

  // Двойное нажатие «Отправить» или повтор после обрыва связи — не создаём вторую заявку.
  const [last] = await store.listRequests(maxUserId, 1);
  if (last && last.description === description && last.category === cat.data && now.getTime() - last.createdAt.getTime() < DUPLICATE_WINDOW_MS) {
    return { ok: true, request: last, duplicate: true };
  }

  const norm = NORMS[cat.data];
  const address = `${formatAddress(apt.house)}, кв. ${apt.number}${apt.entrance ? `, подъезд ${apt.entrance}` : ''}`;
  const request = await store.createRequest(maxUserId, {
    category: cat.data,
    description,
    address,
    orgType: norm.orgType,
    dueAt: computeDueAt(norm, now),
  });
  return { ok: true, request, duplicate: false };
}
