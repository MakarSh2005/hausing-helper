import type { Norm } from './norms.js';

/**
 * Текст жалобы в Госжилинспекцию Республики Татарстан по просроченной заявке.
 * Бот не отправляет жалобу сам и не подставляет выдуманные адреса и телефоны:
 * жилец копирует текст, дописывает ФИО и способ своего обращения в УК.
 */

const ACTS: Array<[RegExp, string]> = [
  [/№ 354/, 'Правила предоставления коммунальных услуг (утв. постановлением Правительства РФ от 06.05.2011 № 354)'],
  [/№ 416/, 'Правила осуществления деятельности по управлению многоквартирными домами (утв. постановлением Правительства РФ от 15.05.2013 № 416)'],
  [/№ 170/, 'Правила и нормы технической эксплуатации жилищного фонда (утв. постановлением Госстроя РФ от 27.09.2003 № 170)'],
];

/** Полные названия актов, на которые ссылается норматив. */
export function actTitles(ref: string): string[] {
  return ACTS.filter(([re]) => re.test(ref)).map(([, title]) => title);
}

const DATE = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });
const DATETIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

export interface ComplaintInput {
  description: string;
  address: string;
  orgName: string | null;
  norm: Norm;
  createdAt: Date;
  dueAt: Date;
  /** Сколько фото приложено к заявке. */
  photos?: number;
}

export function complaintText(c: ComplaintInput): string {
  const orgAcc = c.norm.orgType === 'TKO' ? 'регионального оператора' : 'управляющую организацию';
  const to = c.orgName ?? (c.norm.orgType === 'TKO' ? 'региональному оператору по обращению с ТКО' : 'управляющей организации');
  const acts = actTitles(c.norm.ref);
  return [
    'В Государственную жилищную инспекцию Республики Татарстан',
    '',
    'От: [ФИО полностью], [телефон или e-mail для ответа]',
    `Адрес: ${c.address}`,
    '',
    'Жалоба на неустранение нарушения',
    '',
    `[${DATE.format(c.createdAt)}] я обратился(-ась) к ${to} [по телефону / письменно / через ГИС ЖКХ] по проблеме: «${c.description}».`,
    `Согласно ${c.norm.ref}: ${c.norm.what}.`,
    `Срок истёк ${DATETIME.format(c.dueAt)} (МСК), проблема не устранена.`,
    ...(c.photos ? [`Фотографии прилагаю (${c.photos} шт.).`] : []),
    '',
    `Прошу провести проверку и обязать ${orgAcc} устранить нарушение.`,
    '',
    '[дата]   [подпись]',
    ...(acts.length ? ['', 'Нормативы:', ...acts.map((a) => `— ${a}`)] : []),
  ].join('\n');
}
