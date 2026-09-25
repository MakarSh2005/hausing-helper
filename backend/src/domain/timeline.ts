import type { RequestCategory, RequestStatus } from './enums.js';
import { NORMS } from './norms.js';
import { DEMO_STAGES, OPEN_STATUSES, STATUS_LABEL } from './requestStatus.js';

/**
 * Хронология заявки и уведомления жильца. Ничего не хранится отдельно: события выводятся из полей
 * заявки (создана, срок, напоминание, закрыта) и демо-этапов статуса — так же, как effectiveStatus.
 */

export type TimelineType = 'created' | 'accepted' | 'in_progress' | 'due' | 'overdue' | 'reminded' | 'completed' | 'rejected' | 'cancelled';

export interface TimelineEvent {
  type: TimelineType;
  at: Date;
  /** Событие ещё впереди (срок не наступил). */
  future?: boolean;
  /** Статус показан в демо-режиме (меняется по времени, пока УК не подключена). */
  demo?: boolean;
}

interface RequestLike {
  status: RequestStatus;
  createdAt: Date;
  dueAt: Date;
  reminderSentAt: Date | null;
  updatedAt: Date;
}

export function requestTimeline(r: RequestLike, now: Date, demo: boolean): TimelineEvent[] {
  const open = OPEN_STATUSES.includes(r.status);
  // До какого момента заявка «жила»: у закрытой — время закрытия
  const until = open ? now : r.updatedAt;
  const events: TimelineEvent[] = [{ type: 'created', at: r.createdAt }];

  if (demo) {
    for (const s of DEMO_STAGES) {
      if (s.afterMs === 0) continue;
      const at = new Date(r.createdAt.getTime() + s.afterMs);
      if (at <= until) events.push({ type: s.status as 'accepted' | 'in_progress', at, demo: true });
    }
  } else if (r.status === 'accepted' || r.status === 'in_progress') {
    events.push({ type: r.status, at: r.updatedAt });
  }

  if (r.dueAt > until) {
    if (open) events.push({ type: 'due', at: r.dueAt, future: true });
  } else {
    events.push({ type: 'overdue', at: r.dueAt });
  }
  if (r.reminderSentAt) events.push({ type: 'reminded', at: r.reminderSentAt });
  if (!open) events.push({ type: r.status as 'completed' | 'rejected' | 'cancelled', at: r.updatedAt });

  return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export const TIMELINE_LABEL: Record<TimelineType, string> = {
  created: 'Заявка подана',
  accepted: `Статус: ${STATUS_LABEL.accepted}`,
  in_progress: `Статус: ${STATUS_LABEL.in_progress}`,
  due: 'Срок по нормативу',
  overdue: 'Срок истёк',
  reminded: 'Напоминание отправлено в чат',
  completed: 'Проблема решена',
  rejected: 'Заявка отклонена',
  cancelled: 'Заявка отозвана',
};

export interface Notification {
  id: string;
  kind: 'status' | 'neighbors';
  at: Date;
  title: string;
  text: string;
  requestId?: string;
  category?: RequestCategory;
}

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;

const title = (c: RequestCategory) => (c === 'gas' ? 'Газ' : NORMS[c].title);

/**
 * Уведомления: изменения по своим заявкам (кроме подачи — её жилец сделал сам) и сводка
 * «Соседи уже сообщили» по заявкам соседей из того же дома — только категории и количество.
 */
export function buildNotifications(
  own: Array<RequestLike & { id: string; number: string; category: RequestCategory }>,
  neighbors: Array<{ category: RequestCategory; createdAt: Date }>,
  now: Date,
  demo: boolean,
  limit = 50,
): Notification[] {
  const out: Notification[] = [];
  for (const r of own) {
    for (const e of requestTimeline(r, now, demo)) {
      if (e.type === 'created' || e.type === 'due') continue;
      out.push({
        id: `${r.number}:${e.type}`,
        kind: 'status',
        at: e.at,
        title: `${r.number} · ${title(r.category)}`,
        text: `${TIMELINE_LABEL[e.type]}${e.demo ? ' (демо)' : ''}`,
        requestId: r.id,
      });
    }
  }
  const byCategory = new Map<RequestCategory, Date[]>();
  for (const n of neighbors) byCategory.set(n.category, [...(byCategory.get(n.category) ?? []), n.createdAt]);
  for (const [category, dates] of byCategory) {
    const latest = new Date(Math.max(...dates.map((d) => d.getTime())));
    const n = dates.length;
    out.push({
      id: `nb:${category}:${n}:${latest.getTime()}`,
      kind: 'neighbors',
      at: latest,
      title: 'Соседи уже сообщили',
      text: `${n} ${plural(n, 'заявка', 'заявки', 'заявок')} «${title(category)}» в вашем доме за неделю`,
      category,
    });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
