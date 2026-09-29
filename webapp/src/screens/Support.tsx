import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, AuthError, type SupportAction, type SupportAnswer } from '../api';
import { tap } from '../bridge';
import { phoneHref } from '../format';
import { supportHistory } from '../store';

/**
 * Чат поддержки: автоответы на типовые вопросы (сервер — backend/src/support/faq.ts).
 * Ответы собираются из данных жильца: его УК, заявки, сроки по нормативам.
 * Под ответом — кнопки действий (подать заявку, открыть заявку, позвонить) и подсказки-вопросы.
 */

type Item =
  | { from: 'user'; text: string }
  | { from: 'bot'; text: string; actions?: SupportAction[]; suggestions?: string[] };

export interface SupportHandlers {
  onNewRequest: (category: string | null) => void;
  onOpenRequest: (id: string) => void;
  onAddress: () => void;
  onTab: (tab: 'apartment' | 'requests' | 'notifications') => void;
  onAuthError: (e: AuthError) => void;
}

export function Support(props: SupportHandlers) {
  const [items, setItems] = useState<Item[]>(() => supportHistory.load<Item>());
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(72);
  const { onAuthError } = props;

  // Первое открытие (или история устарела) — приветствие с подсказками
  useEffect(() => {
    if (items.length) return;
    api.supportStart().then(
      (a) => setItems([{ from: 'bot', ...a }]),
      (e) => (e instanceof AuthError ? onAuthError(e) : setError('Нет связи с сервером. Попробуйте ещё раз.')),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => supportHistory.save(items), [items]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setComposerH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }, [items.length, busy]);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setItems((x) => [...x, { from: 'user', text: question }]);
    setText('');
    setBusy(true);
    setError(null);
    try {
      const a: SupportAnswer = await api.support(question);
      setItems((x) => [...x, { from: 'bot', text: a.text, actions: a.actions, suggestions: a.suggestions }]);
      tap();
    } catch (e) {
      if (e instanceof AuthError) return onAuthError(e);
      setError('Нет связи с сервером. Вопрос не отправлен — попробуйте ещё раз.');
      setItems((x) => x.slice(0, -1));
      setText(question);
    } finally {
      setBusy(false);
    }
  }

  function act(a: SupportAction) {
    switch (a.type) {
      case 'new_request':
        return props.onNewRequest(a.category ?? null);
      case 'open_request':
        return props.onOpenRequest(a.id);
      case 'address':
        return props.onAddress();
      case 'tab':
        return props.onTab(a.tab);
      case 'call':
        window.location.href = phoneHref(a.phone);
        return;

    }
  }

  const lastBot = items.map((x, i) => (x.from === 'bot' ? i : -1)).filter((i) => i >= 0).pop();

  return (
    <div className="chat" style={{ paddingBottom: composerH + 12 }}>
      <p className="note chat-note">Автоматические ответы на типовые вопросы. Если что-то угрожает жизни или здоровью — звоните 112.</p>
      <div className="chat-list" role="log" aria-live="polite" aria-label="Переписка с поддержкой">
        {items.map((m, i) =>
          m.from === 'user' ? (
            <div key={i} className="msg msg--mine">
              <div className="msg__bubble">
                <div className="msg__text">{m.text}</div>
              </div>
            </div>
          ) : (
            <div key={i}>
              <div className="msg">
                <span className="msg__avatar support-avatar" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24">
                    <path d="M12 3a8 8 0 0 0-8 8v4a3 3 0 0 0 3 3h1v-7H6a6 6 0 0 1 12 0h-2v7h2v1a2 2 0 0 1-2 2h-3v2h3a4 4 0 0 0 4-4v-1.2A3 3 0 0 0 20 15v-4a8 8 0 0 0-8-8Z" fill="currentColor" />
                  </svg>
                </span>
                <div className="msg__bubble">
                  {i === 0 && <span className="msg__name msg__name--static">Поддержка</span>}
                  <div className="msg__text">{m.text}</div>
                </div>
              </div>
              {!!m.actions?.length && (
                <div className="support-actions">
                  {m.actions.map((a, j) => (
                    <button key={j} className={`support-action${a.type === 'call' ? ' support-action--call' : ''}`} onClick={() => act(a)}>
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
              {i === lastBot && !!m.suggestions?.length && !busy && (
                <div className="chips support-suggest" aria-label="Частые вопросы">
                  {m.suggestions.map((s) => (
                    <button key={s} className="chip" onClick={() => void ask(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="msg">
            <span className="msg__avatar" />
            <div className="msg__bubble typing" aria-label="Поддержка печатает">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      <div className="composer" ref={composerRef}>
        {error && (
          <p className="composer__error" role="alert">
            {error}
          </p>
        )}
        <div className="composer__row">
          <textarea
            className="input composer__input"
            rows={1}
            maxLength={500}
            placeholder="Ваш вопрос"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(text);
              }
            }}
            aria-label="Вопрос в поддержку"
          />
          <button className="composer__send" onClick={() => void ask(text)} disabled={!text.trim() || busy} aria-label="Отправить">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2z" fill="currentColor" />
            </svg>
          </button>
        </div>
        {items.length > 1 && (
          <div style={{ textAlign: 'center', marginTop: 6 }}>
            <button
              className="linkish support-clear"
              onClick={() => {
                supportHistory.clear();
                setItems([]);
                api.supportStart().then((a) => setItems([{ from: 'bot', ...a }]), () => {});
              }}
            >
              Начать заново
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
