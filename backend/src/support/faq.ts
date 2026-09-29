import type { ApartmentInfo, RequestInfo } from '../bot/store.js';
import { formatAddress } from '../domain/address.js';
import { detectCategory } from '../domain/category.js';
import type { RequestCategory } from '../domain/enums.js';
import { CATEGORY_ORDER, formatMsk, NORMS } from '../domain/norms.js';
import { effectiveStatus, OPEN_STATUSES, STATUS_LABEL } from '../domain/requestStatus.js';

/**
 * Чат поддержки в мини-приложении: ответы на типовые вопросы жильца без LLM.
 * Вопрос сопоставляется с темами по ключевым словам; ответ собирается из данных самого жильца
 * (его УК и её телефоны, сроки по нормативам, его заявки). Если тему не узнали, но в вопросе
 * описана проблема («течёт батарея») — отвечаем про эту категорию и предлагаем подать заявку.
 * Телефоны — только из проверенных данных, как и везде в сервисе.
 */

export type SupportAction =
  | { type: 'new_request'; label: string; category?: string }
  | { type: 'open_request'; label: string; id: string }
  | { type: 'address'; label: string }
  | { type: 'call'; label: string; phone: string }
  | { type: 'tab'; label: string; tab: 'apartment' | 'requests' | 'notifications' };

export interface SupportAnswer {
  topic: string;
  text: string;
  actions: SupportAction[];
  /** Следующие вопросы — кнопками под ответом. */
  suggestions: string[];
}

export interface SupportContext {
  apartment: ApartmentInfo | null;
  requests: RequestInfo[];
  now: Date;
  demo: boolean;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

type Topic = { id: string; patterns: RegExp[]; answer: (ctx: SupportContext, q: string) => SupportAnswer };

// ─── общие куски ответов ──────────────────────────────────────────────────

function ukLine(ctx: SupportContext): string {
  const uk = ctx.apartment?.house.manager;
  if (!ctx.apartment) return 'Управляющая компания определится, когда вы укажете адрес.';
  if (!uk) return 'Управляющая компания вашего дома в справочнике не указана.';
  return `Ваша управляющая компания — ${uk.name}.`;
}

function ukCalls(ctx: SupportContext): SupportAction[] {
  const uk = ctx.apartment?.house.manager;
  if (!uk?.verified) return [];
  return [
    ...(uk.dispatcherPhone ? [{ type: 'call' as const, label: `Диспетчер УК ${uk.dispatcherPhone}`, phone: uk.dispatcherPhone }] : []),
    ...(uk.phone && uk.phone !== uk.dispatcherPhone ? [{ type: 'call' as const, label: `УК ${uk.phone}`, phone: uk.phone }] : []),
  ];
}

const openOf = (ctx: SupportContext) => ctx.requests.filter((r) => OPEN_STATUSES.includes(effectiveStatus(r, ctx.now, ctx.demo)));
const noAddress = (ctx: SupportContext): SupportAction[] => (ctx.apartment ? [] : [{ type: 'address', label: 'Указать адрес' }]);

const S = {
  submit: 'Как подать заявку?',
  deadline: 'Какие сроки у заявок?',
  status: 'Что с моей заявкой?',
  overdue: 'Срок прошёл, а ничего не сделали',
  uk: 'Как связаться с УК?',
  emergency: 'Авария — что делать?',
  address: 'Как сменить адрес?',
  privacy: 'Кто видит мои данные?',
  payments: 'Как передать показания счётчиков?',
};

function categoryAnswer(cat: Exclude<RequestCategory, 'gas'>, ctx: SupportContext, lead: string): SupportAnswer {
  const n = NORMS[cat];
  const who = n.orgType === 'TKO' ? 'региональный оператор по вывозу мусора' : 'управляющая компания';
  return {
    topic: `category:${cat}`,
    text: [
      lead,
      `Отвечает ${who}. Срок по нормативу: ${n.what} (${n.ref}).`,
      ...(n.emergency ? ['', 'Если прямо сейчас заливает или есть опасность — сначала позвоните в аварийно-диспетчерскую службу, потом подайте заявку.'] : []),
      '',
      'Подайте заявку — приложение само засечёт срок, напомнит, когда он истечёт, и подготовит жалобу в Госжилинспекцию, если проблему не устранят.',
    ].join('\n'),
    actions: [...noAddress(ctx), { type: 'new_request', label: `Подать заявку: ${n.title}`, category: cat }, ...(n.emergency ? ukCalls(ctx) : [])],
    suggestions: [S.status, S.overdue, S.uk],
  };
}

// ─── темы ─────────────────────────────────────────────────────────────────

const TOPICS: Topic[] = [
  {
    id: 'gas',
    patterns: [/газ(?!он|ет)/, /пахнет газ/],
    answer: () => ({
      topic: 'gas',
      text: [
        'Запах газа — это опасно. Заявку через приложение не оформляйте: звоните сразу.',
        '',
        'Не включайте и не выключайте свет и приборы, не пользуйтесь огнём и лифтом. Откройте окна, выйдите из помещения и позвоните в газовую службу 104 или по единому номеру 112.',
      ].join('\n'),
      actions: [
        { type: 'call', label: 'Газовая служба 104', phone: '104' },
        { type: 'call', label: 'Единый номер 112', phone: '112' },
      ],
      suggestions: [S.emergency],
    }),
  },
  {
    id: 'emergency',
    patterns: [/авари/, /прорвал/, /затоп/, /залива/, /искрит/, /пожар/, /задымл/, /дым /, /срочно/, /экстренн/, /опасн/, /(?<![а-я])112(?![0-9])/],
    answer: (ctx) => ({
      topic: 'emergency',
      text: [
        'Если есть угроза жизни или здоровью — звоните 112. Пожар — 101, запах газа — 104.',
        '',
        'Протечка, засор, нет воды, отопления или света — это аварийно-диспетчерская служба управляющей компании, она работает круглосуточно (п. 13 Правил № 416).',
        ukLine(ctx),
        ctx.apartment?.house.manager && !ctx.apartment.house.manager.verified ? 'Её телефоны мы ещё сверяем с ГИС ЖКХ — пока смотрите их в квитанции или на доске объявлений в подъезде.' : '',
        '',
        'После звонка подайте заявку в приложении — так останется подтверждение, когда вы сообщили о проблеме.',
      ].filter(Boolean).join('\n'),
      actions: [...ukCalls(ctx), { type: 'call', label: 'Единый номер 112', phone: '112' }, { type: 'new_request', label: 'Подать заявку' }],
      suggestions: [S.deadline, S.uk],
    }),
  },
  {
    id: 'human',
    patterns: [/оператор/, /живой/, /живым/, /человек/, /сотрудник/, /консультант/],
    answer: (ctx) => ({
      topic: 'human',
      text: [
        'Здесь отвечает автоматический помощник — он знает ответы на типовые вопросы о заявках, сроках и управляющей компании.',
        'Живого оператора в сервисе пока нет. По срочным вопросам звоните в диспетчерскую службу УК, а проблему в доме оформляйте заявкой — её срок сервис отследит.',
      ].join('\n'),
      actions: [...ukCalls(ctx), { type: 'new_request', label: 'Подать заявку' }],
      suggestions: [S.submit, S.uk],
    }),
  },
  {
    id: 'overdue',
    patterns: [/не (делают|чинят|реагир|отвечают|приходят|пришли|приехал|устранил|починил|сделал)/, /игнор/, /просроч/, /срок (истек|прош|вышел)/, /жалоб/, /гжи/, /жилинспек/, /инспекци/, /куда (жаловат|обратит)/, /пожаловат/],
    answer: (ctx) => {
      const overdue = openOf(ctx).filter((r) => r.dueAt <= ctx.now);
      return {
        topic: 'overdue',
        text: [
          'Если нормативный срок прошёл, а проблема не устранена, можно пожаловаться в Государственную жилищную инспекцию Республики Татарстан — она проверяет управляющие компании.',
          '',
          'В карточке просроченной заявки есть кнопка «Не решена — жалоба в Госжилинспекцию»: приложение соберёт текст жалобы с адресом, датой обращения, нормативом и сроком. Останется дописать ФИО и отправить через Госуслуги, ГИС ЖКХ (dom.gosuslugi.ru) или письмом в ГЖИ.',
          overdue.length ? `\nПросроченных заявок у вас: ${overdue.length}.` : '',
        ].join('\n'),
        actions: overdue.slice(0, 3).map((r) => ({ type: 'open_request' as const, label: `Открыть ${r.number}`, id: r.id })),
        suggestions: [S.status, S.deadline],
      };
    },
  },
  {
    id: 'status',
    patterns: [/статус/, /что с (моей |моими )?заявк/, /мо(я|и|ю|ей) заявк/, /где (моя )?заявк/, /(приняли|рассмотрели|взяли) ли/, /заявк[а-я]* (приняли|приняты|рассмотр)/],
    answer: (ctx) => {
      const open = openOf(ctx);
      if (!ctx.requests.length) {
        return {
          topic: 'status',
          text: 'У вас пока нет заявок. Подать заявку можно кнопкой «Подать заявку» на вкладке «Заявки» — это займёт минуту.',
          actions: [...noAddress(ctx), { type: 'new_request', label: 'Подать заявку' }],
          suggestions: [S.submit, S.deadline],
        };
      }
      const lines = open.slice(0, 5).map((r) => {
        const st = effectiveStatus(r, ctx.now, ctx.demo);
        const late = r.dueAt <= ctx.now ? ` — срок истёк ${formatMsk(r.dueAt)}` : ` — срок до ${formatMsk(r.dueAt)}`;
        return `• ${r.number}, ${r.category === 'gas' ? 'Газ' : NORMS[r.category].title}: ${STATUS_LABEL[st]}${late}`;
      });
      return {
        topic: 'status',
        text: open.length
          ? [`Открытых заявок: ${open.length}.`, ...lines, '', 'Статус меняется в карточке заявки, а о новых статусах сообщает колокольчик вверху.'].join('\n')
          : `Открытых заявок нет — все ${ctx.requests.length} в архиве на вкладке «Заявки».`,
        actions: open.slice(0, 3).map((r) => ({ type: 'open_request' as const, label: `Открыть ${r.number}`, id: r.id })),
        suggestions: [S.overdue, S.deadline],
      };
    },
  },
  {
    id: 'transfer',
    patterns: [/переда(ет|ется|ются|ют)/, /(ук|управляющ[а-я]*) (узна|получ|увид)/, /доход(ит|ят)/, /попад(ет|ают)/, /видит ли ук/, /отправля(ет|ется) в ук/],
    answer: () => ({
      topic: 'transfer',
      text: [
        'Сервис работает в тестовом режиме: заявки хранятся у нас и в управляющую компанию автоматически пока не передаются.',
        'Зато приложение засекает нормативный срок, напоминает о нём и готовит жалобу в Госжилинспекцию. Если проблема срочная — позвоните в диспетчерскую службу УК.',
      ].join('\n'),
      actions: [{ type: 'tab', label: 'Контакты УК', tab: 'apartment' }],
      suggestions: [S.uk, S.overdue],
    }),
  },
  {
    id: 'deadline',
    patterns: [/срок/, /сколько (ждать|времени|дней|часов)/, /когда (почин|отремонт|сделают|устранят|придут|приедут|включат|дадут)/, /норматив/, /как быстро/, /за сколько/],
    answer: (ctx, q) => {
      const cat = detectCategory(q);
      if (cat && cat !== 'gas') return categoryAnswer(cat, ctx, `Про «${NORMS[cat].title}»:`);
      return {
        topic: 'deadline',
        text: [
          'Сроки по нормативам (Правила № 354, № 416, № 170):',
          ...CATEGORY_ORDER.map((c) => `• ${NORMS[c].title}: ${NORMS[c].what}`),
          '',
          'Точный срок и основание приложение показывает при подаче заявки и в её карточке — с живым таймером.',
        ].join('\n'),
        actions: [{ type: 'new_request', label: 'Подать заявку' }],
        suggestions: [S.overdue, S.status],
      };
    },
  },
  {
    id: 'submit',
    patterns: [/(подать|оставить|создать|написать|отправить|оформить|сделать|подаю|подавать) [а-я ]{0,15}(заявк|обращени)/, /как (подать|оставить|пожаловаться на)/, /куда (писать|обращаться|сообщить)/, /новая заявк/],
    answer: (ctx, q) => {
      const cat = detectCategory(q);
      if (cat && cat !== 'gas') return categoryAnswer(cat, ctx, `Заявку про «${NORMS[cat].title}» можно подать прямо сейчас.`);
      return {
        topic: 'submit',
        text: [
          'Подать заявку:',
          '1. Вкладка «Заявки» → «Подать заявку».',
          '2. Опишите, что случилось и где, — категория определится сама, её можно сменить.',
          '3. Приложите фото (до 5), если есть.',
          '4. «Отправить заявку».',
          '',
          'После этого в карточке заявки появится срок по нормативу с таймером, а если его нарушат — готовый текст жалобы.',
        ].join('\n'),
        actions: [...noAddress(ctx), { type: 'new_request', label: 'Подать заявку' }],
        suggestions: [S.deadline, S.status],
      };
    },
  },
  {
    id: 'uk',
    patterns: [/управляющ/, /(?<![а-я])ук(?![а-я])/, /кто обслуживает/, /телефон/, /контакт/, /позвонить/, /номер /, /часы работы/, /режим работы/, /график работы/, /диспетчер/],
    answer: (ctx) => {
      const uk = ctx.apartment?.house.manager;
      return {
        topic: 'uk',
        text: [
          ukLine(ctx),
          uk?.verified && uk.dispatcherPhone ? `Аварийно-диспетчерская служба: ${uk.dispatcherPhone} (круглосуточно).` : '',
          uk?.verified && uk.phone ? `Телефон УК: ${uk.phone}.` : '',
          uk?.verified && uk.workingHours ? `Часы работы: ${uk.workingHours}.` : '',
          uk && !uk.verified ? 'Телефоны покажем, как только сверим их с ГИС ЖКХ. Пока их можно найти в квитанции за ЖКУ или на доске объявлений в подъезде.' : '',
          '',
          ctx.apartment ? 'Все контакты — на вкладке «Квартира».' : '',
        ].filter((x, i, a) => x || (i > 0 && a[i - 1])).join('\n').trim(),
        actions: [...noAddress(ctx), ...ukCalls(ctx), ...(ctx.apartment ? [{ type: 'tab' as const, label: 'Вкладка «Квартира»', tab: 'apartment' as const }] : [])],
        suggestions: [S.emergency, S.submit],
      };
    },
  },
  {
    id: 'address',
    patterns: [/адрес/, /переех/, /сменить (квартир|дом)/, /друг(ой|ую) (дом|квартир)/, /привяз/, /не мой дом/, /нет моего дома/],
    answer: (ctx) => ({
      topic: 'address',
      text: [
        ctx.apartment ? `Сейчас указан адрес: ${formatAddress(ctx.apartment.house)}, кв. ${ctx.apartment.number}.` : 'Адрес ещё не указан.',
        'Сменить адрес можно на вкладке «Квартира» → «Сменить адрес» или кнопкой «Сменить адрес» в чате с ботом. Уже поданные заявки останутся с прежним адресом.',
        'Если вашего дома нет в справочнике — в нём пока дома 19 управляющих компаний Казани, справочник будет пополняться.',
      ].join('\n'),
      actions: [{ type: 'address', label: ctx.apartment ? 'Сменить адрес' : 'Указать адрес' }],
      suggestions: [S.uk, S.submit],
    }),
  },
  {
    id: 'cancel',
    patterns: [/отозв/, /отмен/, /удалить заявк/, /ошибочн/, /по ошибке/],
    answer: (ctx) => ({
      topic: 'cancel',
      text: 'Отозвать заявку можно в её карточке: кнопка «Отозвать заявку» внизу, затем подтверждение. Отозванная заявка уходит в архив, напоминаний по ней не будет. Если проблему уже устранили — лучше нажмите «Проблема решена», тогда можно будет оценить работу УК.',
      actions: openOf(ctx).slice(0, 3).map((r) => ({ type: 'open_request' as const, label: `Открыть ${r.number}`, id: r.id })),
      suggestions: [S.status],
    }),
  },
  {
    id: 'photos',
    patterns: [/фото/, /снимок/, /картинк/, /прикреп/, /вложени/, /сфотограф/],
    answer: () => ({
      topic: 'photos',
      text: 'К заявке можно приложить до 5 фото — при подаче или позже, в карточке открытой заявки («+ Фото»). Фото сжимаются на телефоне, так что отправляются быстро даже по мобильному интернету. В жалобу в Госжилинспекцию попадёт отметка, что фото приложены.',
      actions: [{ type: 'new_request', label: 'Подать заявку с фото' }],
      suggestions: [S.submit],
    }),
  },
  {
    id: 'rating',
    patterns: [/оцен/, /рейтинг/, /звезд/, /отзыв/],
    answer: () => ({
      topic: 'rating',
      text: 'Когда проблема решена, нажмите в карточке заявки «Проблема решена» — появится оценка от 1 до 5 звёзд и поле для комментария. Средняя оценка жильцов видна в карточке управляющей компании на вкладке «Квартира».',
      actions: [{ type: 'tab', label: 'Мои заявки', tab: 'requests' }],
      suggestions: [S.status],
    }),
  },
  {
    id: 'notifications',
    patterns: [/уведомлен/, /напомина/, /колокольчик/, /оповещ/],
    answer: () => ({
      topic: 'notifications',
      text: 'Колокольчик вверху справа показывает новые статусы ваших заявок, истёкшие сроки и «Соседи уже сообщили». Когда срок по заявке истекает, бот дополнительно пишет вам в чат MAX с кнопкой «Открыть заявку».',
      actions: [{ type: 'tab', label: 'Открыть уведомления', tab: 'notifications' }],
      suggestions: [S.status],
    }),
  },
  {
    id: 'privacy',
    patterns: [/данн(ые|ых)/, /персональн/, /кто видит/, /безопасн/, /конфиденц/, /приватн/],
    answer: () => ({
      topic: 'privacy',
      text: [
        'Вход — по подписанным данным MAX, пароль не нужен.',
        'Ваши заявки видите только вы. Соседи в «Соседи уже сообщили» видят только количество заявок по категории — без текста, квартиры и имени.',
        'Номер квартиры и описания заявок не записываются в журналы сервера. Фото заявок хранятся на сервере сервиса и отдаются только вам.',
      ].join('\n'),
      actions: [],
      suggestions: [S.submit],
    }),
  },
  {
    id: 'payments',
    patterns: [/оплат/, /квитанц/, /платеж/, /тариф/, /счетчик/, /показани/, /долг/, /перерасчет/, /задолжен/, /стоимост/, /сколько стоит/, /лицев/],
    answer: (ctx) => ({
      topic: 'payments',
      text: [
        'Оплатой, квитанциями и показаниями счётчиков сервис не занимается — он про заявки и сроки их устранения.',
        'Показания и оплату принимают управляющая компания и ресурсоснабжающие организации: через их сайты, Госуслуги (раздел ЖКХ) или ГИС ЖКХ — dom.gosuslugi.ru.',
        'Если услуга была плохого качества (не было воды, отопления), по ПП № 354 положен перерасчёт — заявка в приложении фиксирует, когда вы сообщили о проблеме.',
      ].join('\n'),
      actions: ukCalls(ctx),
      suggestions: [S.uk, S.deadline],
    }),
  },
  {
    id: 'neighbors',
    patterns: [/соседи (уже )?сообщ/, /у соседей тоже/, /друг(ие|их) жильц/],
    answer: () => ({
      topic: 'neighbors',
      text: 'В колокольчике есть «Соседи уже сообщили»: сколько заявок какой категории подали жильцы вашего дома за неделю. Если у вас та же проблема — нажмите «У меня то же — подать заявку»: форма откроется с нужной категорией. Чем больше заявок, тем сложнее управляющей компании их игнорировать.',
      actions: [{ type: 'tab', label: 'Открыть уведомления', tab: 'notifications' }],
      suggestions: [S.submit],
    }),
  },
  {
    id: 'about',
    patterns: [/что (ты )?умеешь/, /помощ/, /(?<![а-я])help/, /чем (ты )?(можешь )?помо/, /как (это |тут |все )?работает/, /что (это|за сервис|за приложение)/, /функци/, /возможност/],
    answer: () => ({
      topic: 'about',
      text: [
        '«Жилищный помощник» помогает решать проблемы в доме:',
        '• подать заявку с фото за минуту',
        '• знать срок по нормативу и следить за ним с таймером',
        '• получить напоминание, когда срок истёк, и готовую жалобу в Госжилинспекцию',
        '• видеть, о чём уже сообщили соседи по дому',
        '• найти контакты своей управляющей компании',
        '',
        'Спросите меня о сроках, заявках, УК или аварии — отвечу.',
      ].join('\n'),
      actions: [{ type: 'new_request', label: 'Подать заявку' }],
      suggestions: [S.submit, S.deadline, S.uk],
    }),
  },
  {
    id: 'thanks',
    patterns: [/^спасиб/, /благодар/, /^ок(ей)?$/, /^понятно/, /^ясно/],
    answer: () => ({ topic: 'thanks', text: 'Пожалуйста! Если появятся вопросы — пишите.', actions: [], suggestions: [S.submit, S.status] }),
  },
  {
    id: 'hello',
    patterns: [/^(привет|здравств|добр(ый|ое|ого)|хай|салют|hello|hi)(?![а-я])/],
    answer: (ctx) => greeting(ctx),
  },
];

export function greeting(ctx: SupportContext): SupportAnswer {
  return {
    topic: 'hello',
    text: [
      'Здравствуйте! Я помощник сервиса «Жилищный помощник» — отвечаю на типовые вопросы о заявках, сроках, управляющей компании и авариях.',
      ctx.apartment ? `Ваш адрес: ${formatAddress(ctx.apartment.house)}, кв. ${ctx.apartment.number}.` : 'Чтобы я отвечал про ваш дом, укажите адрес.',
      'Выберите вопрос ниже или напишите свой.',
    ].join('\n'),
    actions: noAddress(ctx),
    suggestions: [S.submit, S.deadline, S.status, S.uk, S.emergency, S.payments],
  };
}

export function answerQuestion(question: string, ctx: SupportContext): SupportAnswer {
  const q = norm(question);
  if (!q) return greeting(ctx);
  // Газ — всегда первым: даже если спрашивают «как подать заявку, пахнет газом»
  const gas = TOPICS[0]!;
  if (gas.patterns.some((re) => re.test(q))) return gas.answer(ctx, q);

  let best: { topic: Topic; score: number } | null = null;
  for (const topic of TOPICS.slice(1)) {
    const score = topic.patterns.filter((re) => re.test(q)).length;
    if (score > 0 && (!best || score > best.score)) best = { topic, score };
  }
  if (best) return best.topic.answer(ctx, q);

  // Тему не узнали, но описана проблема — отвечаем по категории
  const cat = detectCategory(q);
  if (cat && cat !== 'gas') return categoryAnswer(cat, ctx, `Похоже, это категория «${NORMS[cat].title}».`);

  return {
    topic: 'unknown',
    text: [
      'Я пока не знаю ответа на этот вопрос — я отвечаю на типовые вопросы о заявках, сроках, управляющей компании и авариях.',
      'Если что-то сломалось в доме — опишите это одной фразой, например «течёт батарея» или «не работает лифт», и я подскажу срок и помогу подать заявку.',
    ].join('\n'),
    actions: [{ type: 'new_request', label: 'Подать заявку' }, ...ukCalls(ctx)],
    suggestions: [S.submit, S.deadline, S.uk, S.emergency],
  };
}
