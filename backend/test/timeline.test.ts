import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildNotifications, requestTimeline } from '../src/domain/timeline.js';

const T0 = new Date('2026-09-24T09:00:00Z');
const h = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const base = { createdAt: T0, dueAt: h(2), reminderSentAt: null, updatedAt: T0 };

describe('хронология заявки', () => {
  it('открытая, до срока, демо: подана → принята → в работе → срок (впереди)', () => {
    const t = requestTimeline({ ...base, status: 'created' }, h(1), true);
    assert.deepEqual(t.map((e) => e.type), ['created', 'accepted', 'in_progress', 'due']);
    assert.equal(t.at(-1)!.future, true);
    assert.ok(t[1]!.demo);
  });
  it('без демо: только подача и срок', () => {
    assert.deepEqual(requestTimeline({ ...base, status: 'created' }, h(1), false).map((e) => e.type), ['created', 'due']);
  });
  it('просрочена, напоминание, закрыта как решённая', () => {
    const t = requestTimeline({ ...base, status: 'completed', reminderSentAt: h(2.1), updatedAt: h(3) }, h(5), false);
    assert.deepEqual(t.map((e) => e.type), ['created', 'overdue', 'reminded', 'completed']);
  });
  it('отозвана до срока — ни срока, ни просрочки; демо-этапы только до отзыва', () => {
    const t = requestTimeline({ ...base, status: 'cancelled', updatedAt: new Date(T0.getTime() + 60_000) }, h(5), true);
    assert.deepEqual(t.map((e) => e.type), ['created', 'accepted', 'cancelled']);
  });
});

describe('уведомления', () => {
  it('свои события (без подачи и будущего срока) и сводка по соседям — новые сверху', () => {
    const own = [{ ...base, id: 'r1', number: 'REQ-2026-00001', category: 'heating' as const, status: 'created' as const }];
    const neighbors = [
      { category: 'elevator' as const, createdAt: h(0.5) },
      { category: 'elevator' as const, createdAt: h(1.5) },
      { category: 'roof' as const, createdAt: h(0.2) },
    ];
    const n = buildNotifications(own, neighbors, h(3), true);
    assert.deepEqual(n.map((x) => x.text), [
      'Срок истёк',
      '2 заявки «Лифт» в вашем доме за неделю',
      '1 заявка «Крыша, протечка сверху» в вашем доме за неделю',
      'Статус: в работе (демо)',
      'Статус: принята (демо)',
    ]);
    assert.equal(n[1]!.kind, 'neighbors');
    assert.equal(n[1]!.category, 'elevator');
    assert.equal(n[0]!.requestId, 'r1');
  });
});
