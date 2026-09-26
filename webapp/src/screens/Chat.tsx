import { Button } from '@maxhub/max-ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, AuthError, type ChatAuthor, type ChatData, type ChatMsg } from '../api';
import { openMaxUrl, tap } from '../bridge';

type Loaded = Extract<ChatData, { available: true }>;

const POLL_MS = 4000;
const TIME = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
const dayKey = (iso: string) => DAY.format(new Date(iso));

/** Сообщения по id: новые страницы и опрос не дублируют уже показанные. */
function merge(a: ChatMsg[], b: ChatMsg[]): ChatMsg[] {
  const byId = new Map(a.map((m) => [m.id, m]));
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.at.localeCompare(y.at) || x.id.localeCompare(y.id));
}

const COLORS = ['#e57373', '#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4db6ac', '#f06292', '#7986cb'];
function initials(name: string) {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || '?';
}

export function Avatar({ a, size = 36 }: { a: ChatAuthor; size?: number }) {
  const [broken, setBroken] = useState(false);
  const color = COLORS[[...a.key].reduce((s, c) => s + c.charCodeAt(0), 0) % COLORS.length];
  if (a.photo_url && !broken) {
    return <img className="avatar" src={a.photo_url} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return (
    <span className="avatar" style={{ width: size, height: size, background: color, fontSize: size * 0.4 }} aria-hidden="true">
      {initials(a.name)}
    </span>
  );
}

/** Профиль автора: то, что он сам показывает в MAX, — имя, фото, ник. Квартиры и телефона здесь нет. */
function ProfileSheet({ a, address, onClose }: { a: ChatAuthor; address: string; onClose: () => void }) {
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="profile-name" onClick={onClose}>
      <div className="sheet__body profile" onClick={(e) => e.stopPropagation()}>
        <Avatar a={a} size={88} />
        <h2 id="profile-name">{a.name}</h2>
        {a.username && <span className="field__label">@{a.username}</span>}
        <span className="field__label">Сосед по дому · {address}</span>
        <p className="note" style={{ margin: '12px 0' }}>
          Имя и фото — из профиля MAX. Номер квартиры соседям не показывается.
        </p>
        {a.username && (
          <Button size="medium" stretched onClick={() => openMaxUrl(`https://max.ru/${a.username}`)}>
            Открыть профиль в MAX
          </Button>
        )}
        <Button size="medium" variant="secondary" stretched onClick={onClose} style={{ marginTop: 8 }}>
          Закрыть
        </Button>
      </div>
    </div>
  );
}

export function Chat(props: { onAuthError: (e: AuthError) => void; onNoAddress: () => void; onRead: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'none' | 'error'>('loading');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  /** Граница «новых» — фиксируется при открытии, пока жилец читает. */
  const [readMark, setReadMark] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<ChatAuthor | null>(null);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const stick = useRef(true);
  const first = useRef(true);
  const { onAuthError, onRead } = props;

  const load = useCallback(async () => {
    try {
      const d = await api.chat();
      if (!d.available) {
        setState('none');
        return;
      }
      setData(d);
      setMessages((m) => merge(m, d.messages));
      if (first.current) {
        setHasMore(d.has_more);
        setReadMark(d.last_read_at);
        first.current = false;
      }
      setState('ok');
      onRead();
    } catch (e) {
      if (e instanceof AuthError) onAuthError(e);
      else setState((s) => (s === 'ok' ? s : 'error'));
    }
  }, [onAuthError, onRead]);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Прилипание к низу: пришло новое — прокручиваем, только если жилец и так внизу.
  useEffect(() => {
    const onScroll = () => {
      stick.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  // Первое открытие: к «Новые сообщения», если они есть, иначе в конец. Дальше — только если жилец внизу.
  const positioned = useRef(false);
  useLayoutEffect(() => {
    if (state !== 'ok' || !messages.length) return;
    if (!positioned.current) {
      positioned.current = true;
      const mark = document.querySelector('.chat-new');
      if (mark) mark.scrollIntoView({ block: 'center' });
      else window.scrollTo(0, document.documentElement.scrollHeight);
      return;
    }
    if (stick.current) window.scrollTo(0, document.documentElement.scrollHeight);
  }, [messages.length, state]);

  async function loadEarlier() {
    const oldest = messages[0];
    if (!oldest) return;
    const h = document.documentElement.scrollHeight;
    stick.current = false;
    try {
      const d = await api.chat(oldest.at);
      if (d.available) {
        setMessages((m) => merge(d.messages, m));
        setHasMore(d.has_more);
        // Сохраняем место чтения: страница выросла сверху
        requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight - h + window.scrollY));
      }
    } catch (e) {
      if (e instanceof AuthError) onAuthError(e);
    }
  }

  async function send() {
    const t = text.trim();
    if (!t || sending || !data) return;
    setSending(true);
    setError(null);
    try {
      const r = await api.chatSend(t);
      if (r.ok) {
        stick.current = true;
        setMessages((m) => merge(m, [r.message]));
        setText('');
        setReadMark(null);
        tap();
      } else {
        setError(
          {
            empty: 'Напишите что-нибудь.',
            too_long: `Слишком длинно: не больше ${data.max_text} символов.`,
            too_fast: 'Слишком часто. Подождите минуту.',
            no_apartment: 'Сначала укажите адрес.',
          }[r.error],
        );
      }
    } catch (e) {
      if (e instanceof AuthError) onAuthError(e);
      else setError('Нет связи с сервером. Сообщение не отправлено — попробуйте ещё раз.');
    }
    setSending(false);
  }

  async function remove(id: string) {
    setActionsFor(null);
    try {
      if (await api.chatDelete(id)) setMessages((m) => m.map((x) => (x.id === id ? { ...x, text: null, deleted: true } : x)));
    } catch (e) {
      if (e instanceof AuthError) onAuthError(e);
    }
  }

  async function toggleNotify() {
    if (!data) return;
    setNotifyBusy(true);
    try {
      const on = await api.chatNotify(!data.notify);
      setData({ ...data, notify: on });
      tap();
    } catch (e) {
      if (e instanceof AuthError) onAuthError(e);
    }
    setNotifyBusy(false);
  }

  if (state === 'loading') return <div className="state"><p>Загружаем чат…</p></div>;
  if (state === 'error') {
    return (
      <div className="state">
        <h1>Не удалось загрузить чат</h1>
        <p>Проверьте интернет и попробуйте ещё раз.</p>
        <Button size="medium" onClick={() => (setState('loading'), void load())}>
          Повторить
        </Button>
      </div>
    );
  }
  if (state === 'none' || !data) {
    return (
      <div className="state">
        <h1>Чат дома</h1>
        <p>Здесь общаются соседи по дому. Укажите адрес — и вы сразу окажетесь в чате своего дома.</p>
        <Button size="medium" onClick={props.onNoAddress}>
          Указать адрес
        </Button>
      </div>
    );
  }

  const count = data.members;
  const firstUnread = readMark ? messages.find((m) => !m.mine && m.at > readMark)?.id : undefined;
  let prevDay = '';
  let prevAuthor = '';

  return (
    <div className="chat">
      <section className="card chat-head">
        <div>
          <div className="field__value" style={{ fontWeight: 600 }}>{data.address}</div>
          <span className="field__label">
            {count} {count % 10 === 1 && count % 100 !== 11 ? 'житель' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'жителя' : 'жителей'} в чате
          </span>
        </div>
        <label className={`switch${notifyBusy ? ' switch--busy' : ''}`}>
          <span className="switch__text">Уведомления</span>
          <input type="checkbox" role="switch" checked={data.notify} disabled={notifyBusy || (!data.can_notify && !data.notify)} onChange={() => void toggleNotify()} />
          <span className="switch__track" aria-hidden="true" />
        </label>
      </section>
      <p className="note chat-note">
        {data.notify
          ? 'Бот пришлёт сводку новых сообщений — не чаще раза в 10 минут.'
          : data.can_notify
            ? 'Уведомления выключены. Включите, если хотите получать сводку новых сообщений от бота.'
            : 'Чтобы получать уведомления, сначала напишите что-нибудь боту в чате.'}{' '}
        Соседи видят ваше имя и фото из профиля MAX, номер квартиры — нет.
      </p>

      {hasMore && (
        <div className="gutter" style={{ textAlign: 'center', marginBottom: 8 }}>
          <button className="linkish" onClick={() => void loadEarlier()}>
            Показать более ранние
          </button>
        </div>
      )}
      {messages.length === 0 && <p className="note" style={{ textAlign: 'center', margin: '32px 16px' }}>Сообщений пока нет. Напишите первым — например, о чём стоит знать соседям.</p>}

      <div className="chat-list" role="log" aria-live="polite" aria-label="Сообщения">
        {messages.map((m) => {
          const day = dayKey(m.at);
          const showDay = day !== prevDay;
          const cont = !showDay && prevAuthor === m.author.key;
          prevDay = day;
          prevAuthor = m.author.key;
          return (
            <div key={m.id}>
              {showDay && <div className="chat-day">{day}</div>}
              {m.id === firstUnread && <div className="chat-new">Новые сообщения</div>}
              <div className={`msg${m.mine ? ' msg--mine' : ''}${cont ? ' msg--cont' : ''}`}>
                {!m.mine && (
                  <button className="msg__avatar" onClick={() => setProfile(m.author)} aria-label={`Профиль: ${m.author.name}`} tabIndex={cont ? -1 : 0}>
                    {!cont && <Avatar a={m.author} />}
                  </button>
                )}
                <div
                  className={`msg__bubble${m.deleted ? ' msg__bubble--deleted' : ''}`}
                  onClick={() => m.mine && !m.deleted && setActionsFor(actionsFor === m.id ? null : m.id)}
                >
                  {!m.mine && !cont && (
                    <button className="msg__name" onClick={() => setProfile(m.author)}>
                      {m.author.name}
                    </button>
                  )}
                  <div className="msg__text">{m.deleted ? 'Сообщение удалено' : m.text}</div>
                  <div className="msg__time">{TIME.format(new Date(m.at))}</div>
                </div>
              </div>
              {actionsFor === m.id && (
                <div className="msg__actions">
                  <button className="linkish" onClick={() => setActionsFor(null)}>
                    Отмена
                  </button>
                  <button className="linkish msg__delete" onClick={() => void remove(m.id)}>
                    Удалить сообщение
                  </button>
                </div>
              )}
            </div>
          );
        })}

      </div>

      <div className="composer">
        {error && (
          <p className="composer__error" role="alert">
            {error}
          </p>
        )}
        <div className="composer__row">
          <textarea
            className="input composer__input"
            rows={1}
            maxLength={data.max_text}
            placeholder="Сообщение соседям"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
            }}
            aria-label="Сообщение"
          />
          <button className="composer__send" onClick={() => void send()} disabled={!text.trim() || sending} aria-label="Отправить">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2z" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>
      {profile && <ProfileSheet a={profile} address={data.address} onClose={() => setProfile(null)} />}
    </div>
  );
}
