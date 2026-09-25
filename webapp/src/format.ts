const DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
});
const SHORT = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short' });

/** «24 сентября, 14:00» по Москве. */
export const dateTime = (iso: string) => DATE_TIME.format(new Date(iso)).replace(' в ', ', ');
/** «24 сент.» */
export const shortDate = (iso: string) => SHORT.format(new Date(iso));

export const phoneHref = (p: string) => `tel:${p.replace(/[^\d+]/g, '')}`;
