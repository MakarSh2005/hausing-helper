/**
 * Локальные удобства этого устройства: черновик заявки и отметка «уведомления просмотрены».
 * Хранилище может быть недоступно (приватный режим, запреты webview) — тогда просто работаем без него.
 */
const get = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* без сохранения */
  }
};

export interface Draft {
  text: string;
  category: string | null;
  manual: boolean;
  savedAt: number;
}
const DRAFT = 'hh.draft.v1';
/** Черновик старше недели не восстанавливаем — скорее всего, проблема уже неактуальна. */
const DRAFT_TTL = 7 * 86_400_000;

export const draft = {
  load(): Draft | null {
    try {
      const d = JSON.parse(get(DRAFT) ?? 'null') as Draft | null;
      return d && typeof d.text === 'string' && Date.now() - d.savedAt < DRAFT_TTL ? d : null;
    } catch {
      return null;
    }
  },
  save(d: Omit<Draft, 'savedAt'>) {
    if (!d.text.trim() && !d.category) return set(DRAFT, null);
    set(DRAFT, JSON.stringify({ ...d, savedAt: Date.now() }));
  },
  clear: () => set(DRAFT, null),
};

const SEEN = 'hh.notif.seen';
export const notifSeen = {
  get: (): number => Number(get(SEEN) ?? 0) || 0,
  set: (t: number) => set(SEEN, String(t)),
};
