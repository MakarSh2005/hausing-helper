import { initData } from './bridge';

/** Ответы API бэкенда (backend/src/api/router.ts). */
export interface Org {
  name: string;
  verified: boolean;
  demo: boolean;
  phone: string | null;
  dispatcher_phone: string | null;
  working_hours: string | null;
}

export interface Apartment {
  address: string;
  full_address: string;
  number: string;
  entrance: number | null;
  house: {
    code: string;
    year_built: number | null;
    floors: number | null;
    entrances: number | null;
    apartments_count: number | null;
    data_verified: boolean;
  };
  uk: Org | null;
}

export type Status = 'created' | 'accepted' | 'in_progress' | 'completed' | 'rejected' | 'cancelled';

export interface RequestItem {
  id: string;
  number: string;
  category: string;
  category_title: string;
  description: string;
  status: Status;
  status_label: string;
  status_is_demo: boolean;
  can_cancel: boolean;
  created_at: string;
  due_at: string;
  overdue: boolean;
  org: Org | null;
  norm: { what: string; ref: string } | null;
  address: string;
}

export type AuthProblem = 'no_launch_data' | 'expired' | 'rejected';

export class AuthError extends Error {
  constructor(readonly problem: AuthProblem) {
    super(problem);
  }
}
export class NetworkError extends Error {}

const TOKEN_KEY = 'hh.session';
let token: string | null = null;

/** Хранилище вкладки: переживает перезагрузку страницы, а в недоступном хранилище — просто память. */
const saved = {
  get(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(v: string | null) {
    try {
      if (v) sessionStorage.setItem(TOKEN_KEY, v);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* приватный режим — живём без сохранения */
    }
  },
};

const TIMEOUT_MS = 10_000;

/** fetch с таймаутом: на плохом мобильном интернете запрос не должен висеть бесконечно. */
async function timedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(path, { ...init, signal: ctrl.signal });
  } catch {
    throw new NetworkError('network');
  } finally {
    clearTimeout(timer);
  }
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T | null }> {
  const res = await timedFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, data };
}

/** Код входа из ссылки бота: /app/#t=<код>. После чтения убираем его из адресной строки. */
function takeLinkCode(): string | null {
  const m = /(?:^#|&)t=([^&]+)/.exec(window.location.hash);
  if (!m) return null;
  history.replaceState(history.state, '', window.location.pathname + window.location.search);
  return decodeURIComponent(m[1]!);
}

/**
 * Вход: внутри MAX — подписанные данные клиента; в браузере — код из ссылки бота;
 * иначе — сохранённая в этой вкладке сессия.
 */
export async function login(): Promise<{ firstName: string | null }> {
  const data = initData();
  const code = data ? null : takeLinkCode();
  if (!data && !code) {
    token = saved.get();
    if (token) return { firstName: null };
    throw new AuthError('no_launch_data');
  }
  const r = data
    ? await post<{ token: string; user: { first_name: string | null } }>('/api/auth/session', { web_app_data: data })
    : await post<{ token: string; user: { first_name: string | null } }>('/api/auth/link', { code });
  if (r.status === 401 || r.status === 400) throw new AuthError(code ? 'expired' : 'rejected');
  if (r.status !== 200 || !r.data) throw new NetworkError(`auth ${r.status}`);
  token = r.data.token;
  saved.set(token);
  return { firstName: r.data.user.first_name };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET с одним повтором при сетевой ошибке или 5xx. Истекла сессия внутри MAX — входим заново
 * по данным клиента (они действуют сутки) и повторяем запрос; вне MAX — просим новую ссылку.
 */
async function get<T>(path: string, attempt = 0): Promise<T> {
  let res: Response;
  try {
    res = await timedFetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch (err) {
    if (attempt === 0) {
      await sleep(800);
      return get<T>(path, 1);
    }
    throw err;
  }
  if (res.status === 401) {
    token = null;
    saved.set(null);
    if (attempt === 0 && initData()) {
      await login();
      return get<T>(path, 1);
    }
    throw new AuthError('expired');
  }
  if (res.status >= 500 && attempt === 0) {
    await sleep(800);
    return get<T>(path, 1);
  }
  if (!res.ok) throw new NetworkError(`http ${res.status}`);
  return (await res.json()) as T;
}

/** Отозвать заявку. already_closed — её уже закрыли (сервер вернёт актуальное состояние). */
async function cancelRequest(id: string): Promise<{ ok: true; request: RequestItem } | { ok: false; request: RequestItem | null }> {
  const res = await timedFetch(`/api/requests/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    token = null;
    saved.set(null);
    if (initData()) {
      await login();
      return cancelRequest(id);
    }
    throw new AuthError('expired');
  }
  if (res.status === 409) {
    const b = (await res.json().catch(() => null)) as { request: RequestItem | null } | null;
    return { ok: false, request: b?.request ?? null };
  }
  if (!res.ok) throw new NetworkError(`http ${res.status}`);
  return { ok: true, request: (await res.json()) as RequestItem };
}

export const api = {
  cancel: cancelRequest,
  me: () => get<{ apartment: Apartment | null }>('/api/me'),
  requests: () => get<{ items: RequestItem[] }>('/api/requests'),
  request: (id: string) => get<RequestItem>(`/api/requests/${encodeURIComponent(id)}`),
  /** Публичное имя бота — для кнопки «Написать боту». */
  bot: () =>
    timedFetch('/bot')
      .then((r) => (r.ok ? (r.json() as Promise<{ username?: string }>) : {}))
      .then((b: { username?: string }) => b.username ?? null)
      .catch(() => null),
};
