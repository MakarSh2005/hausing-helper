/**
 * Тонкая обёртка над MAX Bridge (window.WebApp). Вне MAX (браузер по ссылке из бота)
 * объекта может не быть или initData пустая — всё опционально.
 */
interface MaxWebApp {
  initData?: string;
  initDataUnsafe?: { start_param?: string };
  platform?: 'ios' | 'android' | 'desktop' | 'web';
  ready?: () => void;
  close?: () => void;
  openLink?: (url: string) => void;
  openMaxLink?: (url: string) => void;
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: { impactOccurred(style: 'soft' | 'light' | 'medium' | 'heavy' | 'rigid'): void };
}

declare global {
  interface Window {
    WebApp?: MaxWebApp;
  }
}

export const webApp = (): MaxWebApp | undefined => (typeof window !== 'undefined' ? window.WebApp : undefined);

/** Подписанные стартовые данные: непустые — только внутри MAX. */
export const initData = (): string => webApp()?.initData?.trim() ?? '';

export const insideMax = (): boolean => initData().length > 0;

/** Параметр запуска из кнопки бота (open_app payload): какой экран открыть. */
export function startParam(): string | null {
  const w = webApp();
  const direct = w?.initDataUnsafe?.start_param;
  if (direct) return direct;
  try {
    return new URLSearchParams(initData()).get('start_param');
  } catch {
    return null;
  }
}

export function uiPlatform(): 'ios' | 'android' {
  const p = webApp()?.platform;
  if (p === 'ios' || p === 'android') return p;
  return /iPhone|iPad|Macintosh/.test(navigator.userAgent) ? 'ios' : 'android';
}

/** Открыть чат с ботом: внутри MAX — средствами клиента, иначе обычной ссылкой. */
export function openBotChat(username: string | null) {
  const url = `https://max.ru/${username ?? ''}`;
  const w = webApp();
  if (insideMax() && w?.openMaxLink) {
    w.openMaxLink(url);
    return;
  }
  window.location.href = url;
}

export function tap() {
  try {
    webApp()?.HapticFeedback?.impactOccurred('light');
  } catch {
    /* не у всех клиентов есть вибро */
  }
}
