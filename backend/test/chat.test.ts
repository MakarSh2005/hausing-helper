import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import { chatDigestText, createBot, type BotIO } from '../src/bot/bot.js';
import type { Button } from '../src/max/keyboard.js';
import { clock, HOUSES, memoryStore } from './memoryStore.js';

describe('чат дома: сводка ботом', () => {
  it('включил уведомления — одна сводка с кнопкой «Открыть чат дома»; повторно — только после паузы', async () => {
    clock.now = Date.parse('2026-09-26T10:00:00Z');
    const store = memoryStore();
    const sent: Array<{ chat: string; text: string; buttons: Button[] }> = [];
    const io: BotIO = { send: async (chat, text, kb) => void sent.push({ chat, text, buttons: (kb ?? []).flat() }), answer: async () => {} };
    const bot = createBot({
      store, io, logger: pino({ level: 'silent' }),
      options: { now: () => new Date(clock.now), openApp: () => ({ webApp: 'test_bot', contactId: 1 }) },
    });
    await store.ensureUser('1', { name: 'Анна' });
    await store.saveApartment('1', { houseId: HOUSES[0]!.id, number: '1', entrance: null });
    await store.saveApartment('2', { houseId: HOUSES[0]!.id, number: '2', entrance: null });
    await store.setChatNotify('2', true);

    clock.now += 11 * 60_000;
    await store.postChat('1', 'Во дворе перекопали трубу, осторожно', new Date(clock.now));
    assert.equal(await bot.notifyChat(), 1);
    assert.match(sent[0]!.text, /^Чат дома: 1 новое сообщение\.\nАнна: Во дворе перекопали трубу/);
    const b = sent[0]!.buttons[0]!;
    assert.equal(b.text, 'Открыть чат дома');
    assert.equal('payload' in b ? b.payload : undefined, 'chat');

    await store.postChat('1', 'ещё', new Date(clock.now + 1000));
    assert.equal(await bot.notifyChat(), 0, 'пауза 10 минут');
    clock.now += 10 * 60_000 + 2000;
    assert.equal(await bot.notifyChat(), 1);
    assert.equal(sent.length, 2);
    assert.equal(await bot.notifyChat(), 0, 'нечего слать');
  });

  it('текст сводки: склонение и обрезка длинного сообщения', () => {
    assert.match(chatDigestText(5, { name: null, text: 'x' }), /^Чат дома: 5 новых сообщений\.\nСосед: x/);
    assert.match(chatDigestText(3, { name: 'Б', text: 'x' }), /3 новых сообщения/);
    const long = chatDigestText(1, { name: 'Б', text: 'а'.repeat(500) });
    assert.ok(long.split('\n')[1]!.length <= 204);
  });
});
