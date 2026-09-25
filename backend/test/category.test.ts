import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectCategory } from '../src/domain/category.js';
import { computeDueAt, NORMS } from '../src/domain/norms.js';

const cases: Array<[string, string | null]> = [
  ['Течёт батарея', 'heating'],
  ['В квартире холодно, батареи еле тёплые', 'heating'],
  ['не топят уже неделю', 'heating'],
  ['Нет горячей воды с утра', 'water'],
  ['Слабый напор холодной воды', 'water'],
  ['Прорвало трубу в ванной', 'water'],
  ['Соседи сверху затопили', 'water'],
  ['Течёт с потолка в кухне', 'water'],
  ['Засор в раковине, вода не уходит', 'sewerage'],
  ['Забился унитаз', 'sewerage'],
  ['Затопило подвал водой', 'sewerage'],
  ['Лифт не работает второй день', 'elevator'],
  ['Застряли в лифте!', 'elevator'],
  ['Не горит свет в подъезде', 'lighting'],
  ['На 3 этаже на площадке перегорела лампочка', 'lighting'],
  ['Нет света в квартире', 'electricity'],
  ['Искрит щиток на этаже', 'electricity'],
  ['Протекает крыша', 'roof'],
  ['Живу на последнем этаже, с потолка течёт после дождя', 'roof'],
  ['Сосульки над входом', 'roof'],
  ['Не закрывается входная дверь в подъезд', 'entrance'],
  ['Разбито окно между этажами', 'entrance'],
  ['В подъезде грязно, не убирают', 'entrance'],
  ['Не вывозят мусор третий день', 'garbage'],
  ['Контейнеры переполнены', 'garbage'],
  ['Во дворе не убран снег', 'yard'],
  ['Сломали лавочку на детской площадке', 'yard'],
  ['Пахнет газом на лестнице', 'gas'],
  ['Газон во дворе вытоптан', 'yard'],
  ['Хочу узнать про тарифы', null],
  ['здравствуйте', null],
];

describe('определение категории', () => {
  for (const [text, expected] of cases) {
    it(`«${text}» → ${expected}`, () => assert.equal(detectCategory(text), expected));
  }
});

describe('нормативы', () => {
  it('у каждой категории есть срок и ссылка на норматив', () => {
    for (const n of Object.values(NORMS)) {
      assert.ok((n.hours ?? 0) > 0 || (n.workingDays ?? 0) > 0, n.category);
      assert.match(n.ref, /Правил\S* № (354|416|170)/, n.category);
    }
  });
  it('рабочие дни пропускают выходные (МСК)', () => {
    const fri = new Date('2026-09-25T12:00:00Z'); // пятница, 15:00 МСК
    const due = computeDueAt({ ...NORMS.other, workingDays: 1 }, fri);
    assert.equal(due.toISOString(), '2026-09-28T12:00:00.000Z'); // понедельник
  });
});
