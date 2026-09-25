import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { houseKey, matchHouse, parseAddressQuery } from '../src/domain/address.js';
import { isValidOrgInn } from '../src/domain/inn.js';

const H = (id: string, street: string, houseNumber: string, building: string | null = null) => ({ id, street, houseNumber, building });
const houses = [
  H('b10', 'ул. Баумана', '10'),
  H('b15', 'ул. Баумана', '15'),
  H('b22', 'ул. Баумана', '22'),
  H('mj8', 'ул. Мусы Джалиля', '8'),
  H('km15', 'ул. Карла Маркса', '15'),
  H('p5', 'пр-т Победы', '100', '2'),
  H('p6', 'пр-т Победы', '100', '3'),
  H('kr15', 'ул. Кремлёвская', '15'),
  H('lb5', 'ул. Лобачевского', '5'),
];

const found = (q: string) => {
  const r = matchHouse(q, houses);
  return r.kind === 'found' ? r.houses.map((h) => h.id) : r.kind;
};

describe('разбор адреса', () => {
  it('три написания одного дома → Баумана 15 (критерий этапа 3)', () => {
    for (const q of ['Баумана 15', 'ул. Баумана, д. 15', 'улица баумана дом 15', 'Казань, Баумана, 15']) {
      assert.deepEqual(found(q), ['b15'], q);
    }
  });

  it('опечатки в улице', () => {
    assert.deepEqual(found('Бауманна 15'), ['b15']);
    assert.deepEqual(found('баумна 15'), ['b15']);
    assert.deepEqual(found('Лобачевкого 5'), ['lb5']);
  });

  it('улица из двух слов, частичное название, ё/е', () => {
    assert.deepEqual(found('Джалиля 8'), ['mj8']);
    assert.deepEqual(found('М. Джалиля, д.8'), ['mj8']);
    assert.deepEqual(found('Карла Маркса 15'), ['km15']);
    assert.deepEqual(found('Кремлевская 15'), ['kr15']);
  });

  it('квартира в том же сообщении запоминается', () => {
    const r = matchHouse('Баумана 15 кв 42', houses);
    assert.equal(r.kind, 'found');
    assert.equal(r.query.apartment, '42');
    assert.equal(parseAddressQuery('ул. Баумана, д. 15, квартира 7').apartment, '7');
  });

  it('корпуса: без корпуса — оба варианта, с корпусом — точный', () => {
    assert.deepEqual(found('Победы 100'), ['p5', 'p6']);
    assert.deepEqual(found('пр. Победы 100 корп 3'), ['p6']);
    assert.deepEqual(found('Победы 100/2'), ['p5']);
  });

  it('улица есть, номера нет → предлагаем дома на улице', () => {
    const r = matchHouse('Баумана 99', houses);
    assert.equal(r.kind, 'no_number');
    if (r.kind === 'no_number') assert.deepEqual(r.houses.map((h) => h.houseNumber), ['10', '15', '22']);
  });

  it('номер не указан → просим выбрать', () => {
    assert.equal(matchHouse('улица Баумана', houses).kind, 'need_number');
  });

  it('неизвестная улица и мусор → not_found, без ложных совпадений', () => {
    for (const q of ['Ленина 5', 'привет', '12345', '', 'Течёт батарея']) {
      assert.equal(matchHouse(q, houses).kind, 'not_found', q);
    }
  });

  it('houseKey одинаков для разных написаний', () => {
    const k = houseKey('Казань', 'ул. Баумана', '15');
    assert.equal(houseKey('казань', 'Баумана', 'д. 15'), k);
    assert.equal(houseKey('Казань', 'улица Баумана', 'дом 15'), k);
    assert.notEqual(houseKey('Казань', 'пр-т Победы', '100', '2'), houseKey('Казань', 'пр-т Победы', '100'));
  });
});

describe('ИНН', () => {
  it('контрольная цифра', () => {
    assert.equal(isValidOrgInn('1655102541'), true); // ООО «УК Вахитовского района»
    assert.equal(isValidOrgInn('7707083893'), true); // ПАО Сбербанк
    assert.equal(isValidOrgInn('1655318904'), false);
    assert.equal(isValidOrgInn('123'), false);
  });
});

describe('дробь в номере дома', () => {
  const H = [
    { id: 'a', street: 'ул. 25-го Октября', houseNumber: '13/6', building: null },
    { id: 'b', street: 'ул. Баумана', houseNumber: '15', building: '2' },
    { id: 'c', street: 'ул. Баумана', houseNumber: '15', building: null },
  ];
  it('«13/6» — угловой дом целиком; «13» тоже находит его', () => {
    for (const q of ['25 Октября 13/6', 'ул. 25-го октября, д. 13 / 6', '25 октября 13']) {
      const r = matchHouse(q, H);
      assert.ok(r.kind === 'found' && r.houses[0]!.id === 'a', `${q} → ${r.kind}`);
    }
  });
  it('«15/2», где дроби в справочнике нет, — дом 15 корпус 2', () => {
    const r = matchHouse('Баумана 15/2', H);
    assert.ok(r.kind === 'found' && r.houses.length === 1 && r.houses[0]!.id === 'b');
  });
});

