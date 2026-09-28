import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RequestInfo } from '../src/bot/store.js';
import { answerQuestion, greeting, type SupportContext } from '../src/support/faq.js';
import { HOUSES } from './memoryStore.js';

const now = new Date('2026-09-28T12:00:00Z');
const house = HOUSES.find((h) => h.manager?.verified) ?? HOUSES[0]!;
const ctx = (over: Partial<SupportContext> = {}): SupportContext => ({
  apartment: { number: '42', entrance: 2, house },
  requests: [],
  houseChat: null,
  now,
  demo: false,
  ...over,
});

describe('чат поддержки: типовые вопросы', () => {
  const cases: Array<[string, string]> = [
    ['Как подать заявку?', 'submit'],
    ['как оставить заявку', 'submit'],
    ['Сколько ждать, если сломался лифт?', 'category:elevator'],
    ['Какие сроки?', 'deadline'],
    ['когда починят батарею', 'category:heating'],
    ['Что с моей заявкой?', 'status'],
    ['Срок прошёл, а ничего не сделали', 'overdue'],
    ['куда пожаловаться на УК', 'overdue'],
    ['Как позвонить в управляющую компанию?', 'uk'],
    ['телефон диспетчера', 'uk'],
    ['Пахнет газом в подъезде', 'gas'],
    ['как подать заявку, пахнет газом', 'gas'],
    ['Затопили соседи сверху, что делать?', 'emergency'],
    ['Как сменить адрес?', 'address'],
    ['я переехал', 'address'],
    ['Как отменить заявку', 'cancel'],
    ['можно прикрепить фото?', 'photos'],
    ['как оценить работу', 'rating'],
    ['Есть ли чат дома?', 'chat'],
    ['Кто видит мои данные?', 'privacy'],
    ['Как передать показания счётчиков?', 'payments'],
    ['где квитанция за ЖКУ', 'payments'],
    ['заявка передается в УК?', 'transfer'],
    ['Что ты умеешь?', 'about'],
    ['Привет', 'hello'],
    ['спасибо!', 'thanks'],
    ['позовите оператора', 'human'],
    ['Течёт батарея', 'category:heating'],
    ['не вывозят мусор третий день', 'category:garbage'],
    ['какая погода завтра', 'unknown'],
  ];
  for (const [q, topic] of cases) {
    it(`«${q}» → ${topic}`, () => assert.equal(answerQuestion(q, ctx()).topic, topic));
  }

  it('ответы — по данным жильца: УК, телефоны только проверенные, заявки, чат дома', () => {
    const uk = answerQuestion('телефон УК', ctx());
    assert.match(uk.text, new RegExp(house.manager!.name.replace(/[«»"()]/g, '.')));
    const unverified = { ...house, manager: { ...house.manager!, verified: false } };
    const u2 = answerQuestion('телефон УК', ctx({ apartment: { number: '1', entrance: null, house: unverified } }));
    assert.ok(!u2.actions.some((a) => a.type === 'call'), 'непроверенные телефоны не показываем');
    assert.match(u2.text, /сверим их с ГИС ЖКХ/);

    const r = { id: 'r1', number: 'REQ-2026-00007', category: 'elevator', description: 'лифт', status: 'created', createdAt: new Date(now.getTime() - 48 * 3_600_000), dueAt: new Date(now.getTime() - 24 * 3_600_000), reminderSentAt: null, updatedAt: now, org: null, address: 'a', house, photos: [], rating: null } as RequestInfo;
    const st = answerQuestion('статус заявки', ctx({ requests: [r] }));
    assert.match(st.text, /REQ-2026-00007, Лифт: зарегистрирована — срок истёк/);
    assert.deepEqual(st.actions[0], { type: 'open_request', label: 'Открыть REQ-2026-00007', id: 'r1' });
    assert.match(answerQuestion('срок прошел', ctx({ requests: [r] })).text, /Просроченных заявок у вас: 1/);

    const chat = answerQuestion('чат соседей', ctx({ houseChat: { houseId: house.id, chatId: '-1', title: 'Баумана 15', link: 'https://max.ru/join/x', createdAt: now } }));
    assert.deepEqual(chat.actions, [{ type: 'link', label: 'Вступить в чат дома', url: 'https://max.ru/join/x' }]);
    assert.match(answerQuestion('чат соседей', ctx()).text, /\/дом <адрес>/);

    const noApt = greeting(ctx({ apartment: null }));
    assert.deepEqual(noApt.actions, [{ type: 'address', label: 'Указать адрес' }]);
    assert.ok(greeting(ctx()).suggestions.length >= 4);
  });

  it('сроки в ответе — из того же справочника нормативов, что и в заявках', () => {
    const t = answerQuestion('какие сроки', ctx()).text;
    assert.match(t, /Вывоз мусора: перерыв в вывозе мусора — не более 24 часов подряд/);
    assert.match(t, /Лифт: устранить неисправность лифта — не более 1 суток/);
  });
});
