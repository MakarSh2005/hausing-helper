import { Button } from '@maxhub/max-ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, AuthError, type ChatAuthor, type ChatData, type ChatMsg, type ChatUploadError } from '../api';
import { openMaxUrl, tap } from '../bridge';
import { compressImage } from '../image';
import { audioDuration, canRecord, FileAttachment, fmtDuration, fmtSize, PhotoAttachment, PhotoViewer, useVoiceRecorder, VoiceNote } from './ChatMedia';

/** Вложение, выбранное, но ещё не отправленное. */
type Pending = { key: string; kind: 'photo' | 'file'; blob: Blob; name: string; preview?: string };
const MAX_PENDING = 5;
const DOC_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.txt,.csv,.rtf,.zip,.jpg,.jpeg,.png';
const UPLOAD_ERROR: Record<ChatUploadError, string> = {
  too_long: 'Подпись слишком длинная.',
  too_fast: 'Слишком часто. Подождите минуту.',
  no_apartment: 'Сначала укажите адрес.',
  too_big: 'Файл слишком большой.',
  bad_media: 'Этот файл не похож на фото или аудиозапись.',
  bad_file_type: 'Такой тип файла не принимаем: можно PDF, документы Word и Excel, презентации, текст, архив ZIP и картинки.',
  bad_kind: 'Вложения временно недоступны.',
};

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
  const [pending, setPending] = useState<Pending[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const [micError, setMicError] = useState<string | null>(null);
  // Панель ввода растёт (вложения, ошибки) — отступ снизу у ленты растёт вместе с ней
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(72);
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setComposerH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [state]);
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

  function added(m: ChatMsg) {
    stick.current = true;
    setMessages((x) => merge(x, [m]));
    setReadMark(null);
  }

  async function uploadVoice(blob: Blob, seconds: number) {
    if (!data) return;
    if (blob.size > data.limits.voice) {
      setError(`Запись слишком длинная: не больше ${fmtSize(data.limits.voice)}.`);
      return;
    }
    setSending(true);
    setError(null);
    setProgress('Отправляем голосовое…');
    try {
      const r = await api.chatUpload('voice', blob, { duration: seconds });
      if (r.ok) (added(r.message), tap());
      else setError(UPLOAD_ERROR[r.error]);
    } catch (e) {
      if (e instanceof AuthError) onAuthError(e);
      else setError('Нет связи с сервером. Голосовое не отправлено.');
    }
    setProgress(null);
    setSending(false);
  }

  const recorder = useVoiceRecorder(data?.limits.voice_sec ?? 300, (b, s) => void uploadVoice(b, s), (msg) => setMicError(msg));

  async function pick(kind: 'photo' | 'file', files: FileList | null) {
    setMenu(false);
    setMicError(null);
    if (!files?.length || !data) return;
    const room = MAX_PENDING - pending.length;
    const list = [...files].slice(0, Math.max(0, room));
    setError(files.length > room ? `За раз — не больше ${MAX_PENDING} вложений.` : null);
    const next: Pending[] = [];
    for (const f of list) {
      if (kind === 'photo') {
        const blob = await compressImage(f);
        if (blob.size > data.limits.photo) {
          setError(`Фото «${f.name}» слишком большое.`);
          continue;
        }
        next.push({ key: `${Date.now()}-${Math.random()}`, kind, blob, name: f.name, preview: URL.createObjectURL(blob) });
      } else {
        if (f.size > data.limits.file) {
          setError(`Файл «${f.name}» больше ${fmtSize(data.limits.file)}.`);
          continue;
        }
        next.push({ key: `${Date.now()}-${Math.random()}`, kind, blob: f, name: f.name });
      }
    }
    setPending((p) => [...p, ...next]);
    if (photoInput.current) photoInput.current.value = '';
    if (fileInput.current) fileInput.current.value = '';
  }

  function unpick(key: string) {
    setPending((p) => {
      const x = p.find((y) => y.key === key);
      if (x?.preview) URL.revokeObjectURL(x.preview);
      return p.filter((y) => y.key !== key);
    });
  }

  async function pickAudio(files: FileList | null) {
    const f = files?.[0];
    if (audioInput.current) audioInput.current.value = '';
    if (!f) return;
    setMicError(null);
    await uploadVoice(f, await audioDuration(f));
  }

  async function sendPending() {
    if (!data) return;
    setSending(true);
    setError(null);
    const caption = text.trim();
    let sentCaption = false;
    const left: Pending[] = [];
    for (const [i, p] of pending.entries()) {
      setProgress(pending.length > 1 ? `Отправляем ${i + 1} из ${pending.length}…` : p.kind === 'photo' ? 'Отправляем фото…' : 'Отправляем файл…');
      try {
        const r = await api.chatUpload(p.kind, p.blob, { name: p.name, caption: sentCaption ? '' : caption });
        if (r.ok) {
          added(r.message);
          sentCaption = true;
          if (p.preview) URL.revokeObjectURL(p.preview);
        } else {
          setError(`«${p.name}»: ${UPLOAD_ERROR[r.error]}`);
          if (r.error !== 'bad_file_type' && r.error !== 'bad_media' && r.error !== 'too_big') left.push(p);
        }
      } catch (e) {
        if (e instanceof AuthError) return onAuthError(e);
        setError('Нет связи с сервером. Неотправленные вложения остались — попробуйте ещё раз.');
        left.push(p);
      }
    }
    setPending(left);
    if (sentCaption) setText('');
    if (sentCaption) tap();
    setProgress(null);
    setSending(false);
  }

  async function send() {
    if (pending.length) return sendPending();
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
    <div className="chat" style={{ paddingBottom: composerH + 12 }}>
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
                  className={`msg__bubble${m.deleted ? ' msg__bubble--deleted' : ''}${m.attachment?.kind === 'photo' ? ' msg__bubble--photo' : ''}`}
                  onClick={() => m.mine && !m.deleted && setActionsFor(actionsFor === m.id ? null : m.id)}
                >
                  {!m.mine && !cont && (
                    <button className="msg__name" onClick={() => setProfile(m.author)}>
                      {m.author.name}
                    </button>
                  )}
                  {m.attachment?.kind === 'photo' && <PhotoAttachment a={m.attachment} onOpen={setViewer} />}
                  {m.attachment?.kind === 'voice' && <VoiceNote a={m.attachment} />}
                  {m.attachment?.kind === 'file' && <FileAttachment a={m.attachment} />}
                  {(m.deleted || m.text) && <div className="msg__text">{m.deleted ? 'Сообщение удалено' : m.text}</div>}
                  <div className="msg__time">
                    {m.mine && !m.deleted && m.attachment && (
                      <button
                        className="msg__more"
                        aria-label="Действия с сообщением"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActionsFor(actionsFor === m.id ? null : m.id);
                        }}
                      >
                        ⋯
                      </button>
                    )}
                    {TIME.format(new Date(m.at))}
                  </div>
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

      <div className="composer" ref={composerRef}>
        {(error || micError || progress) && (
          <p className={progress && !error ? 'composer__progress' : 'composer__error'} role={error || micError ? 'alert' : 'status'}>
            {error ?? micError ?? progress}
            {micError && (
              <>
                {' '}
                <button className="linkish" onClick={() => audioInput.current?.click()}>
                  Выбрать аудиозапись
                </button>
              </>
            )}
          </p>
        )}
        {pending.length > 0 && (
          <div className="pending" aria-label="Вложения к отправке">
            {pending.map((p) => (
              <div key={p.key} className={`pending__item pending__item--${p.kind}`}>
                {p.preview ? <img src={p.preview} alt={p.name} /> : <span className="pending__name">{p.name}</span>}
                <button className="pending__remove" onClick={() => unpick(p.key)} aria-label={`Убрать ${p.name}`} disabled={sending}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {menu && (
          <div className="attach-menu" role="menu">
            <button role="menuitem" onClick={() => photoInput.current?.click()}>
              Фото
            </button>
            <button role="menuitem" onClick={() => fileInput.current?.click()}>
              Файл
            </button>
          </div>
        )}
        {recorder.state.kind === 'recording' ? (
          <div className="composer__row recording" aria-live="polite">
            <button className="composer__icon" onClick={() => recorder.stop(false)} aria-label="Отменить запись">
              <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z" fill="currentColor" />
              </svg>
            </button>
            <span className="recording__dot" aria-hidden="true" />
            <span className="recording__time">{fmtDuration(recorder.elapsed)}</span>
            <span className="recording__hint">Идёт запись</span>
            <button className="composer__send" onClick={() => recorder.stop(true)} aria-label="Отправить голосовое">
              <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2z" fill="currentColor" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="composer__row">
            {data.uploads && (
              <button
                className="composer__icon"
                onClick={() => setMenu((v) => !v)}
                aria-label="Прикрепить фото или файл"
                aria-expanded={menu}
                disabled={sending || pending.length >= MAX_PENDING}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M16.5 6.5v10a4.5 4.5 0 0 1-9 0V5.5a3 3 0 0 1 6 0V15a1.5 1.5 0 0 1-3 0V6.5H9V15a3 3 0 0 0 6 0V5.5a4.5 4.5 0 0 0-9 0v11a6 6 0 0 0 12 0v-10h-1.5Z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            )}
            <textarea
              className="input composer__input"
              rows={1}
              maxLength={data.max_text}
              placeholder={pending.length ? 'Подпись — необязательно' : 'Сообщение соседям'}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
              }}
              onFocus={() => setMenu(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
              }}
              aria-label="Сообщение"
            />
            {text.trim() || pending.length || !data.uploads ? (
              <button className="composer__send" onClick={() => void send()} disabled={(!text.trim() && !pending.length) || sending} aria-label="Отправить">
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2z" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button
                className="composer__send composer__send--mic"
                onClick={() => {
                  setMenu(false);
                  setMicError(null);
                  setError(null);
                  if (canRecord()) void recorder.start();
                  else audioInput.current?.click();
                }}
                disabled={sending || recorder.state.kind === 'starting'}
                aria-label="Записать голосовое"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            )}
          </div>
        )}
        <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => void pick('photo', e.target.files)} />
        <input ref={fileInput} type="file" accept={DOC_ACCEPT} multiple hidden onChange={(e) => void pick('file', e.target.files)} />
        <input ref={audioInput} type="file" accept="audio/*" capture hidden onChange={(e) => void pickAudio(e.target.files)} />
      </div>
      {viewer && <PhotoViewer url={viewer} onClose={() => setViewer(null)} />}
      {profile && <ProfileSheet a={profile} address={data.address} onClose={() => setProfile(null)} />}
    </div>
  );
}
