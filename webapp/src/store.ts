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

type SupportItem = { from: 'user' | 'bot'; text: string; actions?: unknown[]; suggestions?: string[] };
const SUPPORT_KEY = 'hh.support.v2';
/** История чата поддержки на устройстве: последние 40 сообщений, сутки. */
export const supportHistory = {
  load<T extends SupportItem>(): T[] {
    try {
      const raw = JSON.parse(localStorage.getItem(SUPPORT_KEY) ?? 'null') as { at: number; items: T[] } | null;
      return raw && Date.now() - raw.at < 86_400_000 && Array.isArray(raw.items) ? raw.items : [];
    } catch {
      return [];
    }
  },
  save(items: SupportItem[]) {
    try {
      localStorage.setItem(SUPPORT_KEY, JSON.stringify({ at: Date.now(), items: items.slice(-40) }));
    } catch {
      /* без сохранения */
    }
  },
  clear() {
    try {
      localStorage.removeItem(SUPPORT_KEY);
    } catch {
      /* нечего чистить */
    }
  },
};
