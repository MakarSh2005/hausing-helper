import { useCallback, useEffect, useState } from 'react';
import { api, AuthError, login, NetworkError, type Apartment as Apt, type AppNotification, type Catalog, type RequestItem } from './api';
import { Header, Notifications } from './components';
import { notifSeen } from './store';
import { insideMax, openBotChat, startParam, tap, webApp } from './bridge';
import { Apartment } from './screens/Apartment';
import { ChangeAddress } from './screens/ChangeAddress';
import { Chat } from './screens/Chat';
import { NewRequest } from './screens/NewRequest';
import { RequestDetails } from './screens/RequestDetails';
import { Requests } from './screens/Requests';
import { Loading, StateScreen } from './ui';

type Route = { name: 'requests' } | { name: 'request'; id: string } | { name: 'apartment' } | { name: 'new' } | { name: 'notifications' } | { name: 'address' } | { name: 'chat' };

const BASE = '/app/';

function parseRoute(pathname: string): Route {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : '';
  const m = /^requests\/([A-Za-z0-9-]{1,64})\/?$/.exec(rest);
  if (m) return { name: 'request', id: m[1]! };
  if (/^apartment\/?$/.test(rest)) return { name: 'apartment' };
  if (/^new\/?$/.test(rest)) return { name: 'new' };
  if (/^notifications\/?$/.test(rest)) return { name: 'notifications' };
  if (/^address\/?$/.test(rest)) return { name: 'address' };
  if (/^chat\/?$/.test(rest)) return { name: 'chat' };
  return { name: 'requests' };
}
/** Экран из параметра запуска бота: «apartment» или «req_<id>». */
function initialRoute(): Route {
  const fromPath = parseRoute(window.location.pathname);
  if (fromPath.name !== 'requests') return fromPath;
  const p = startParam();
  const m = p ? /^req_([A-Za-z0-9-]{1,64})$/.exec(p) : null;
  if (m) return { name: 'request', id: m[1]! };
  if (p === 'apartment') return { name: 'apartment' };
  if (p === 'new') return { name: 'new' };
  if (p === 'address') return { name: 'address' };
  if (p === 'chat') return { name: 'chat' };
  return fromPath;
}
const routePath = (r: Route) =>
  BASE + (r.name === 'request' ? `requests/${r.id}` : r.name === 'requests' ? '' : r.name);
/** Экраны без вкладок, с кнопкой «Назад». */
const isInner = (r: Route) => r.name === 'request' || r.name === 'new' || r.name === 'notifications' || r.name === 'address' || r.name === 'chat';

type Phase =
  | { kind: 'auth' }
  | { kind: 'auth_error'; problem: 'no_launch_data' | 'expired' | 'rejected' }
  | { kind: 'net_error' }
  | { kind: 'ready' };

type Data<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ok'; value: T } | { status: 'error'; notFound: boolean };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'auth' });
  const [route, setRoute] = useState<Route>(initialRoute);
  const [requests, setRequests] = useState<Data<RequestItem[]>>({ status: 'idle' });
  const [apartment, setApartment] = useState<Data<Apt | null>>({ status: 'idle' });
  const [detail, setDetail] = useState<Data<RequestItem>>({ status: 'idle' });
  const [bot, setBot] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Data<Catalog>>({ status: 'idle' });
  const [banner, setBanner] = useState<{ text: string; warn?: boolean } | null>(null);
  const [notifs, setNotifs] = useState<AppNotification[]>([]);
  const [seen, setSeen] = useState(() => notifSeen.get());
  /** Граница «новых» на экране уведомлений — до того, как отметили их просмотренными. */
  const [seenBefore, setSeenBefore] = useState(0);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [chatUnread, setChatUnread] = useState(0);

  const fail = useCallback((err: unknown, set: (d: Data<never>) => void) => {
    if (err instanceof AuthError) setPhase({ kind: 'auth_error', problem: err.problem });
    else set({ status: 'error', notFound: err instanceof NetworkError && err.message === 'http 404' });
  }, []);

  const loadRequests = useCallback(() => {
    setRequests((d) => (d.status === 'ok' ? d : { status: 'loading' }));
    api.requests().then((r) => setRequests({ status: 'ok', value: r.items }), (e) => fail(e, setRequests));
  }, [fail]);
  const loadApartment = useCallback(() => {
    setApartment((d) => (d.status === 'ok' ? d : { status: 'loading' }));
    api.me().then((r) => setApartment({ status: 'ok', value: r.apartment }), (e) => fail(e, setApartment));
  }, [fail]);

  // Вход. Нет связи — это не «вход отклонён»: показываем отдельный экран с повтором.
  const doLogin = useCallback(() => {
    setPhase({ kind: 'auth' });
    login().then(
      () => setPhase({ kind: 'ready' }),
      (e) => setPhase(e instanceof AuthError ? { kind: 'auth_error', problem: e.problem } : { kind: 'net_error' }),
    );
  }, []);
  useEffect(() => {
    webApp()?.ready?.();
    void api.bot().then(setBot);
    doLogin();
  }, [doLogin]);

  // Квартира нужна везде: шапка (телефоны аварийных служб) и форма заявки
  useEffect(() => {
    if (phase.kind === 'ready') loadApartment();
  }, [phase.kind, loadApartment]);

  // Уведомления: при входе, раз в минуту и при возвращении в приложение
  const loadNotifs = useCallback(() => {
    api.notifications().then((r) => setNotifs(r.items), () => {});
    api.chatUnread().then((r) => setChatUnread(r.count), () => {});
  }, []);
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    loadNotifs();
    const t = setInterval(() => document.visibilityState === 'visible' && loadNotifs(), 60_000);
    const onVisible = () => document.visibilityState === 'visible' && loadNotifs();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [phase.kind, loadNotifs]);
  useEffect(() => {
    if (route.name !== 'notifications') return;
    setSeenBefore(seen);
    const now = Date.now();
    notifSeen.set(now);
    setSeen(now);
    loadNotifs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.name]);
  const unread = notifs.filter((n) => !n.read && new Date(n.at).getTime() > seen).length;

  // Счётчик на кнопке чата — чаще, чем остальные уведомления: запрос лёгкий, а сообщения живые
  useEffect(() => {
    if (phase.kind !== 'ready' || route.name === 'chat') return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') api.chatUnread().then((r) => setChatUnread(r.count), () => {});
    }, 15_000);
    return () => clearInterval(t);
  }, [phase.kind, route.name]);

  // Данные под текущий экран
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    if (route.name === 'requests') loadRequests();
    if (route.name === 'apartment') loadApartment();
    if (route.name === 'new') {
      if (catalog.status !== 'ok') api.catalog().then((c) => setCatalog({ status: 'ok', value: c }), (e) => fail(e, setCatalog));
    }
    if (route.name !== 'request' && route.name !== 'apartment') setBanner(null);
    if (route.name === 'request') {
      const cached = requests.status === 'ok' ? requests.value.find((r) => r.id === route.id) : undefined;
      setDetail(cached ? { status: 'ok', value: cached } : { status: 'loading' });
      api.request(route.id).then((r) => setDetail({ status: 'ok', value: r }), (e) => fail(e, setDetail));
    }
    // requests намеренно не в зависимостях: кеш нужен только для мгновенного показа
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, route, loadRequests, loadApartment, fail]);

  // Вернулись в приложение из чата — обновляем: статус мог смениться.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || phase.kind !== 'ready') return;
      if (route.name === 'requests') loadRequests();
      if (route.name === 'apartment') loadApartment();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [phase.kind, route.name, loadRequests, loadApartment]);

  // Навигация: история браузера + кнопка «Назад» клиента MAX на экране заявки
  const go = useCallback((r: Route) => {
    tap();
    const depth = ((history.state as { depth?: number } | null)?.depth ?? 0) + 1;
    history.pushState({ depth }, '', routePath(r));
    setRoute(r);
    window.scrollTo(0, 0);
  }, []);
  const back = useCallback(() => {
    if (((history.state as { depth?: number } | null)?.depth ?? 0) > 0) history.back();
    else {
      history.replaceState({ depth: 0 }, '', routePath({ name: 'requests' }));
      setRoute({ name: 'requests' });
    }
  }, []);
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    const bb = webApp()?.BackButton;
    if (!bb) return;
    if (!isInner(route)) {
      bb.hide();
      return;
    }
    bb.show();
    bb.onClick(back);
    return () => bb.offClick(back);
  }, [route, back]);

  const writeBot = () => openBotChat(bot);
  const onChatAuthError = useCallback((e: AuthError) => setPhase({ kind: 'auth_error', problem: e.problem }), []);
  // Открыли чат — прочитано: гасим и кнопку чата, и сообщения чата в колокольчике
  const onChatRead = useCallback(() => {
    setChatUnread(0);
    setNotifs((ns) => (ns.some((n) => n.kind === 'chat' && !n.read) ? ns.map((n) => (n.kind === 'chat' ? { ...n, read: true } : n)) : ns));
  }, []);

  /** Заявка подана: открываем её карточку вместо формы (форма не остаётся в истории — «Назад» ведёт к списку). */
  const onCreated = (r: RequestItem, note: string | null) => {
    setRequests((d) => (d.status === 'ok' ? { status: 'ok', value: [r, ...d.value.filter((x) => x.id !== r.id)] } : d));
    setDetail({ status: 'ok', value: r });
    history.replaceState(history.state, '', routePath({ name: 'request', id: r.id }));
    setRoute({ name: 'request', id: r.id });
    setBanner(note ? { text: `Заявка ${r.number} зарегистрирована. ${note}`, warn: true } : { text: `Заявка ${r.number} зарегистрирована.` });
    tap();
    window.scrollTo(0, 0);
  };
  /** Адрес сохранён: экран «Квартира» с новым адресом; форма адреса не остаётся в истории. */
  const onAddressSaved = (a: Apt) => {
    const had = apartment.status === 'ok' && !!apartment.value;
    setApartment({ status: 'ok', value: a });
    history.replaceState(history.state, '', routePath({ name: 'apartment' }));
    setRoute({ name: 'apartment' });
    setBanner({ text: `${had ? 'Адрес изменён' : 'Адрес сохранён'}: ${a.address}, кв. ${a.number}.` });
    loadNotifs();
    tap();
    window.scrollTo(0, 0);
  };
  const reloadDetail = (id: string) => api.request(id).then((r) => setDetail({ status: 'ok', value: r }), (e) => fail(e, setDetail));
  const resolve = async (id: string) => {
    try {
      const r = await api.resolve(id);
      if (r) {
        setDetail({ status: 'ok', value: r });
        setRequests((d) => (d.status === 'ok' ? { status: 'ok', value: d.value.map((x) => (x.id === id ? r : x)) } : d));
        setBanner({ text: `Заявка ${r.number} закрыта как решённая.` });
      } else void reloadDetail(id);
      tap();
    } catch (e) {
      if (e instanceof AuthError) setPhase({ kind: 'auth_error', problem: e.problem });
      else setBanner({ text: 'Не удалось сохранить: нет связи с сервером. Попробуйте ещё раз.', warn: true });
    }
  };

  /** Отзыв: обновляем карточку и список; текст ошибки — для блока подтверждения, null — успех. */
  const cancel = async (id: string): Promise<string | null> => {
    try {
      const res = await api.cancel(id);
      const updated = res.request;
      if (updated) {
        setDetail({ status: 'ok', value: updated });
        setRequests((d) => (d.status === 'ok' ? { status: 'ok', value: d.value.map((x) => (x.id === id ? updated : x)) } : d));
      }
      tap();
      return res.ok || updated ? null : 'Заявка уже закрыта.';
    } catch (e) {
      if (e instanceof AuthError) {
        setPhase({ kind: 'auth_error', problem: e.problem });
        return null;
      }
      return 'Не удалось отозвать: нет связи с сервером. Попробуйте ещё раз.';
    }
  };

  if (phase.kind === 'auth') return <Loading label="Входим…" />;
  if (phase.kind === 'net_error') {
    return <StateScreen title="Нет связи с сервером" text="Проверьте интернет и попробуйте ещё раз." action={{ label: 'Повторить', onClick: doLogin }} />;
  }
  if (phase.kind === 'auth_error') {
    const texts = {
      no_launch_data: {
        title: 'Откройте из чата с ботом',
        text: 'Приложение показывает ваши заявки и квартиру, поэтому открывается из MAX: кнопкой «Приложение с заявками» в чате с ботом.',
      },
      expired: {
        title: 'Ссылка устарела',
        text: 'Откройте приложение заново кнопкой «Приложение с заявками» в чате с ботом.',
      },
      rejected: {
        title: 'Не удалось войти',
        text: 'MAX не подтвердил вход. Закройте приложение и откройте его снова из чата с ботом.',
      },
    }[phase.problem];
    return <StateScreen {...texts} action={bot ? { label: 'Открыть чат с ботом', onClick: writeBot } : undefined} />;
  }

  const onTab = (name: 'requests' | 'apartment') => {
    if (route.name !== name) go({ name });
  };
  const openNew = (category: string | null = null) => {
    setNewCategory(category);
    go({ name: 'new' });
  };

  const showFab = !isInner(route);
  return (
    <main className={`page${showFab ? ' page--fab' : ''}`}>
      <div className="page__inner">
      <Header
        apartment={apartment.status === 'ok' ? apartment.value : null}
        unread={route.name === 'notifications' ? 0 : unread}
        onBell={() => route.name !== 'notifications' && go({ name: 'notifications' })}
      />
      {!isInner(route) && (
        <div className="tabs" role="tablist" aria-label="Разделы">
          <button className="tab" role="tab" aria-selected={route.name === 'apartment'} onClick={() => onTab('apartment')}>
            Квартира
          </button>
          <button className="tab" role="tab" aria-selected={route.name === 'requests'} onClick={() => onTab('requests')}>
            Заявки
          </button>
        </div>
      )}

      {isInner(route) && !insideMax() && (
        <div className="gutter" style={{ marginBottom: 12 }}>
          <a className="linkish" href={routePath({ name: 'requests' })} onClick={(e) => (e.preventDefault(), back())}>
            ← Все заявки
          </a>
        </div>
      )}
      {(route.name === 'new' || route.name === 'notifications' || route.name === 'address' || route.name === 'chat') && (
        <h1 className="gutter" style={{ fontSize: 22, margin: '0 0 12px', color: 'var(--text-primary)' }}>
          {route.name === 'new'
            ? 'Новая заявка'
            : route.name === 'notifications'
              ? 'Уведомления'
              : route.name === 'chat'
                ? 'Чат дома'
              : apartment.status === 'ok' && apartment.value
                ? 'Сменить адрес'
                : 'Указать адрес'}
        </h1>
      )}
      {route.name === 'notifications' && (
        <Notifications
          items={notifs}
          seenBefore={seenBefore}
          onOpenRequest={(id) => go({ name: 'request', id })}
          onJoin={(category) => openNew(category)}
          onOpenChat={() => go({ name: 'chat' })}
        />
      )}
      {banner && (route.name === 'request' || route.name === 'apartment') && (
        <div className={`banner${banner.warn ? ' banner--warn' : ''}`} role="status" style={{ marginBottom: 12 }}>
          {banner.text}
        </div>
      )}

      {route.name === 'requests' && (
        <DataView data={requests} retry={loadRequests}>
          {(items) => <Requests items={items} onOpen={(id) => go({ name: 'request', id })} onNew={() => openNew()} />}
        </DataView>
      )}
      {route.name === 'request' && (
        <DataView
          data={detail}
          retry={() => setRoute({ ...route })}
          notFound={{ title: 'Заявка не найдена', text: 'Возможно, ссылка от другой заявки.', action: { label: 'Все заявки', onClick: back } }}
        >
          {(r) => (
            <RequestDetails
              r={r}
              maxPhotos={catalog.status === 'ok' ? catalog.value.max_photos : 5}
              onCancel={() => cancel(r.id)}
              onResolve={() => resolve(r.id)}
              onChanged={() => void reloadDetail(r.id)}
              onUpdated={(u) => {
                setDetail({ status: 'ok', value: u });
                setRequests((d) => (d.status === 'ok' ? { status: 'ok', value: d.value.map((x) => (x.id === u.id ? u : x)) } : d));
                setBanner(u.rating ? { text: 'Спасибо! Оценка сохранена.' } : null);
                tap();
              }}
            />
          )}
        </DataView>
      )}
      {route.name === 'new' && (
        <DataView data={both(apartment, catalog)} retry={() => setRoute({ name: 'new' })}>
          {([a, c]) =>
            a ? (
              <NewRequest
                key={newCategory ?? 'plain'}
                catalog={c}
                apartment={a}
                initialCategory={newCategory}
                onCreated={(r, note) => (setNewCategory(null), onCreated(r, note), loadNotifs())}
                onAuthError={(e) => setPhase({ kind: 'auth_error', problem: e.problem })}
              />
            ) : (
              <StateScreen
                title="Сначала укажите адрес"
                text="Заявка привязывается к вашей квартире. Укажите адрес дома — это нужно один раз."
                action={{ label: 'Указать адрес', onClick: () => go({ name: 'address' }) }}
              />
            )
          }
        </DataView>
      )}
      {route.name === 'apartment' && (
        <DataView data={apartment} retry={loadApartment}>
          {(a) => <Apartment apartment={a} onChangeAddress={() => go({ name: 'address' })} />}
        </DataView>
      )}
      {route.name === 'chat' && <Chat onAuthError={onChatAuthError} onNoAddress={() => go({ name: 'address' })} onRead={onChatRead} onNotifyChanged={loadNotifs} />}
      {route.name === 'address' && (
        <DataView data={apartment} retry={loadApartment}>
          {(a) => (
            <ChangeAddress
              current={a}
              onSaved={onAddressSaved}
              onCancel={back}
              onAuthError={(e) => setPhase({ kind: 'auth_error', problem: e.problem })}
            />
          )}
        </DataView>
      )}
      </div>
      {showFab && (
        <button className="chat-fab" onClick={() => go({ name: 'chat' })} aria-label={chatUnread ? `Чат дома: новых сообщений — ${chatUnread}` : 'Чат дома'}>
          <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-4.4 3.5A1 1 0 0 1 3 20.7V6a2 2 0 0 1 1-2Zm3 6.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"
              fill="currentColor"
            />
          </svg>
          {chatUnread > 0 && <span className="bell__badge">{chatUnread > 9 ? '9+' : chatUnread}</span>}
        </button>
      )}
    </main>
  );
}

/** Два источника данных как один: ждём оба, ошибка любого — ошибка экрана. */
function both<A, B>(a: Data<A>, b: Data<B>): Data<[A, B]> {
  if (a.status === 'error') return a;
  if (b.status === 'error') return b;
  if (a.status === 'ok' && b.status === 'ok') return { status: 'ok', value: [a.value, b.value] };
  return { status: 'loading' };
}

function DataView<T>(props: {
  data: Data<T>;
  retry: () => void;
  children: (v: T) => React.ReactNode;
  notFound?: { title: string; text: string; action: { label: string; onClick: () => void } };
}) {
  const d = props.data;
  switch (d.status) {
    case 'idle':
    case 'loading':
      return <Loading />;
    case 'error':
      if (props.notFound && d.notFound) return <StateScreen {...props.notFound} />;
      return (
        <StateScreen
          title="Не удалось загрузить"
          text="Проверьте интернет и попробуйте ещё раз."
          action={{ label: 'Повторить', onClick: props.retry }}
        />
      );
    case 'ok':
      return <>{props.children(d.value)}</>;
  }
}
