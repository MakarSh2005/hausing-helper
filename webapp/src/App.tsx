import { useCallback, useEffect, useState } from 'react';
import { api, AuthError, login, NetworkError, type Apartment as Apt, type RequestItem } from './api';
import { insideMax, openBotChat, startParam, tap, webApp } from './bridge';
import { Apartment } from './screens/Apartment';
import { RequestDetails } from './screens/RequestDetails';
import { Requests } from './screens/Requests';
import { Loading, StateScreen } from './ui';

type Route = { name: 'requests' } | { name: 'request'; id: string } | { name: 'apartment' };

const BASE = '/app/';

function parseRoute(pathname: string): Route {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : '';
  const m = /^requests\/([A-Za-z0-9-]{1,64})\/?$/.exec(rest);
  if (m) return { name: 'request', id: m[1]! };
  if (/^apartment\/?$/.test(rest)) return { name: 'apartment' };
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
  return fromPath;
}
const routePath = (r: Route) => BASE + (r.name === 'request' ? `requests/${r.id}` : r.name === 'apartment' ? 'apartment' : '');

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

  // Данные под текущий экран
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    if (route.name === 'requests') loadRequests();
    if (route.name === 'apartment') loadApartment();
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
    if (route.name !== 'request') {
      bb.hide();
      return;
    }
    bb.show();
    bb.onClick(back);
    return () => bb.offClick(back);
  }, [route.name, back]);

  const writeBot = () => openBotChat(bot);

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
        text: 'Приложение показывает ваши заявки и квартиру, поэтому открывается из MAX: кнопкой «Открыть в приложении» в чате с ботом.',
      },
      expired: {
        title: 'Ссылка устарела',
        text: 'Нажмите «Мои заявки» в чате с ботом и откройте приложение по новой кнопке.',
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

  return (
    <main className="page">
      <div className="page__inner">
      {route.name !== 'request' && (
        <div className="tabs" role="tablist" aria-label="Разделы">
          <button className="tab" role="tab" aria-selected={route.name === 'requests'} onClick={() => onTab('requests')}>
            Заявки
          </button>
          <button className="tab" role="tab" aria-selected={route.name === 'apartment'} onClick={() => onTab('apartment')}>
            Квартира
          </button>
        </div>
      )}

      {route.name === 'request' && !insideMax() && (
        <div className="gutter" style={{ marginBottom: 12 }}>
          <a className="linkish" href={routePath({ name: 'requests' })} onClick={(e) => (e.preventDefault(), back())}>
            ← Все заявки
          </a>
        </div>
      )}

      {route.name === 'requests' && (
        <DataView data={requests} retry={loadRequests}>
          {(items) => <Requests items={items} onOpen={(id) => go({ name: 'request', id })} onWriteBot={writeBot} />}
        </DataView>
      )}
      {route.name === 'request' && (
        <DataView
          data={detail}
          retry={() => setRoute({ ...route })}
          notFound={{ title: 'Заявка не найдена', text: 'Возможно, ссылка от другой заявки.', action: { label: 'Все заявки', onClick: back } }}
        >
          {(r) => <RequestDetails r={r} onCancel={() => cancel(r.id)} />}
        </DataView>
      )}
      {route.name === 'apartment' && (
        <DataView data={apartment} retry={loadApartment}>
          {(a) => <Apartment apartment={a} onWriteBot={writeBot} />}
        </DataView>
      )}
      </div>
    </main>
  );
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
