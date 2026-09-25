import type { RequestStatus } from './enums.js';

/**
 * Отображаемый статус заявки (ТЗ 5.2.4). Ничего не хранится в памяти процесса:
 * статус считается от createdAt при каждом чтении, поэтому переживает рестарт контейнера.
 *
 * Демо-режим (MOCK_AUTO_STATUS_CHANGE=true) показывает, как статусы будут меняться, когда
 * УК подключится к сервису: «зарегистрирована» → через 30 с «принята» → через 5 мин «в работе».
 * Без демо-режима показывается сохранённый статус.
 */
export const DEMO_STAGES: ReadonlyArray<{ afterMs: number; status: RequestStatus }> = [
  { afterMs: 0, status: 'created' },
  { afterMs: 30_000, status: 'accepted' },
  { afterMs: 300_000, status: 'in_progress' },
];

/** Открытые статусы: по ним идут сроки и напоминания, их можно отозвать. */
export const OPEN_STATUSES: RequestStatus[] = ['created', 'accepted', 'in_progress'];
export const isOpen = (s: RequestStatus) => OPEN_STATUSES.includes(s);

export function effectiveStatus(
  r: { status: RequestStatus; createdAt: Date },
  now: Date,
  demo: boolean,
): RequestStatus {
  if (!OPEN_STATUSES.includes(r.status)) return r.status;
  if (!demo) return r.status;
  const age = now.getTime() - r.createdAt.getTime();
  return DEMO_STAGES.filter((s) => age >= s.afterMs).pop()?.status ?? 'created';
}

export const STATUS_LABEL: Record<RequestStatus, string> = {
  created: 'зарегистрирована',
  accepted: 'принята',
  in_progress: 'в работе',
  completed: 'решена',
  rejected: 'отклонена',
  cancelled: 'отозвана',
};

