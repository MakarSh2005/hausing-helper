import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { matchHouse } from '../src/domain/address.js';
import { houseKey } from '../src/domain/address.js';
import { isValidOrgInn } from '../src/domain/inn.js';

/** Проверки настоящего справочника, который загружает seed: он меняется при каждом импорте из Excel. */
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'reference', 'kazan-houses.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
  verified: boolean;
  actualAt: string;
  organizations: Array<{ inn: string; name: string }>;
  houses: Array<{ code: string; street: string; houseNumber: string; building: string; managerInn: string }>;
};
const houses = data.houses.map((h, i) => ({ ...h, id: `h${i}`, building: h.building || null }));
const bare = (street: string) => street.replace(/^(ул\.|пер\.|тер\.|пр-кт|б-р|пр\.|ш\.) /, '').replace(/ (пер\.|ул\.)$/, '');

describe(`справочник домов (${data.houses.length} домов, ${data.organizations.length} УК)`, () => {
  it('каждый дом находится по «улица номер» и по «улица, д. номер» без типа улицы', () => {
    const bad: string[] = [];
    for (const h of houses) {
      const corp = h.building ? ` корп ${h.building}` : '';
      for (const q of [`${h.street} ${h.houseNumber}${corp}`, `${bare(h.street)}, д. ${h.houseNumber}${corp}`]) {
        const r = matchHouse(q, houses);
        if (!(r.kind === 'found' && r.houses.some((x) => x.id === h.id))) bad.push(`${q} → ${r.kind}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  it('у каждого дома есть номер, УК из списка, уникальные код и адрес', () => {
    const inns = new Set(data.organizations.map((o) => o.inn));
    const codes = new Set<string>();
    const keys = new Set<string>();
    for (const h of data.houses) {
      assert.ok(h.houseNumber, `${h.code}: пустой номер`);
      assert.ok(inns.has(h.managerInn), `${h.code}: УК ${h.managerInn} нет в списке`);
      assert.ok(!codes.has(h.code), `повтор кода ${h.code}`);
      const k = houseKey('Казань', h.street, h.houseNumber, h.building);
      assert.ok(!keys.has(k), `повтор адреса ${h.street} ${h.houseNumber}`);
      codes.add(h.code);
      keys.add(k);
    }
  });

  it('помечен проверенным — значит, все ИНН УК проходят контрольную цифру и указана дата', () => {
    if (!data.verified) return;
    for (const o of data.organizations) assert.ok(isValidOrgInn(o.inn), `${o.name}: ИНН ${o.inn}`);
    assert.match(data.actualAt, /^\d{2}\.\d{2}\.\d{4}$/);
  });
});
