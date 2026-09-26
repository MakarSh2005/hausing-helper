import { useEffect, useState } from 'react';
import type { Apartment, AppNotification, RequestItem } from './api';
import { dateTime, phoneHref } from './format';

// ─── шапка: номера аварийных служб и уведомления — две плитки справа вверху ──

export function Header(props: { apartment: Apartment | null; unread: number; onBell: () => void }) {
  const [sos, setSos] = useState(false);
  return (
    <>
      <div className="header">
        <button className="hdr-btn hdr-btn--sos" onClick={() => setSos(true)} aria-label="Номера аварийной службы" title="Номера аварийной службы">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1l-2.2 2.2Z"
              fill="currentColor"
            />
          </svg>
        </button>
        <button className="hdr-btn" onClick={props.onBell} aria-label={props.unread ? `Уведомления: ${props.unread} новых` : 'Уведомления'}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 3a6 6 0 0 0-6 6v3.6L4.3 15.4A1 1 0 0 0 5.2 17h13.6a1 1 0 0 0 .9-1.6L18 12.6V9a6 6 0 0 0-6-6Zm0 18a2.5 2.5 0 0 0 2.4-2h-4.8a2.5 2.5 0 0 0 2.4 2Z"
              fill="currentColor"
            />
          </svg>
          {props.unread > 0 && <span className="bell__badge">{props.unread > 9 ? '9+' : props.unread}</span>}
        </button>
      </div>
      {sos && <EmergencySheet apartment={props.apartment} onClose={() => setSos(false)} />}
    </>
  );
}

/** Номера аварийных служб: диспетчер УК — только из проверенных данных, остальное — федеральные номера. */
function EmergencySheet(props: { apartment: Apartment | null; onClose: () => void }) {
  const uk = props.apartment?.uk;
  const rows: Array<{ title: string; hint: string; phone: string }> = [];
  if (uk?.dispatcher_phone) rows.push({ title: 'Аварийно-диспетчерская служба УК', hint: 'протечки, засоры, нет воды или света', phone: uk.dispatcher_phone });
  if (uk?.phone) rows.push({ title: uk.dispatcher_phone ? 'Управляющая компания' : 'Управляющая компания (дежурный номер не указан)', hint: uk.name, phone: uk.phone });
  rows.push({ title: 'Газовая служба', hint: 'запах газа', phone: '104' });
  rows.push({ title: 'Единая служба спасения', hint: 'пожар, угроза жизни и здоровью', phone: '112' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sos-title" onClick={props.onClose}>
      <div className="sheet__body" onClick={(e) => e.stopPropagation()}>
        <h2 id="sos-title">Аварийные службы</h2>
        <p className="field__label" style={{ margin: '0 0 8px' }}>
          Если угрожает жизни или здоровью — сразу звоните 112.
        </p>
        {rows.map((r) => (
          <a key={r.phone + r.title} className="sos-row" href={phoneHref(r.phone)}>
            <span>
              <span className="field__value" style={{ fontWeight: 600, display: 'block' }}>
                {r.title}
              </span>
              <span className="field__label">{r.hint}</span>
            </span>
            <span className="sos-row__phone">{r.phone}</span>
          </a>
        ))}
        {!uk?.phone && (
          <p className="field__label" style={{ margin: '8px 0 0' }}>
            Телефон вашей УК появится здесь, когда её данные будут сверены с ГИС ЖКХ.
          </p>
        )}
        <button className="sheet__close" onClick={props.onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}

// ─── живой таймер срока ───────────────────────────────────────────────────

function span(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = `${String(s % 60).padStart(2, '0')} с`;
  // Больше суток — до минут; меньше — с секундами, чтобы было видно, что время идёт
  if (d > 0) return `${d} д ${h} ч ${m} мин`;
  if (h > 0) return `${h} ч ${m} мин ${sec}`;
  return `${m} мин ${sec}`;
}

export function Countdown({ r }: { r: RequestItem }) {
  const [now, setNow] = useState(() => Date.now());
  const open = r.can_cancel;
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  const start = new Date(r.created_at).getTime();
  const due = new Date(r.due_at).getTime();
  const left = due - now;
  const share = Math.min(1, Math.max(0, (now - start) / Math.max(1, due - start)));
  const tone = left <= 0 ? 'over' : share > 0.75 ? 'warn' : 'ok';

  if (!open) {
    return (
      <div className="timer">
        <span className="field__label">Срок был</span>
        <span className="field__value">до {dateTime(r.due_at)} (МСК)</span>
      </div>
    );
  }
  return (
    <div className={`timer timer--${tone}`} role="timer" aria-live="off">
      <span className="field__label">{left > 0 ? 'До конца нормативного срока' : 'Срок истёк'}</span>
      <span className="timer__value">{left > 0 ? `осталось ${span(left)}` : `просрочено на ${span(-left)}`}</span>
      <div className="timer__bar" aria-hidden="true">
        <div style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <span className="field__label">до {dateTime(r.due_at)} (МСК)</span>
    </div>
  );
}

// ─── хронология заявки ────────────────────────────────────────────────────

export function Timeline({ r }: { r: RequestItem }) {
  return (
    <section className="card" aria-labelledby="tl-title">
      <span id="tl-title" className="field__label">
        Хронология
      </span>
      <ol className="timeline">
        {r.timeline.map((e) => (
          <li key={e.type + e.at} className={`timeline__item${e.future ? ' timeline__item--future' : ''}${e.type === 'overdue' ? ' timeline__item--bad' : ''}`}>
            <span className="timeline__dot" aria-hidden="true" />
            <span className="field__value">
              {e.label}
              {e.demo ? ' (демо)' : ''}
            </span>
            <span className="field__label">
              {e.future ? 'ожидается до ' : ''}
              {dateTime(e.at)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ─── экран уведомлений ────────────────────────────────────────────────────

export function Notifications(props: {
  items: AppNotification[];
  seenBefore: number;
  onOpenRequest: (id: string) => void;
  onJoin: (category: string) => void;
}) {
  if (props.items.length === 0) {
    return (
      <div className="state" style={{ minHeight: '50dvh', background: 'transparent' }}>
        <h1>Уведомлений пока нет</h1>
        <p>Здесь появятся новые статусы ваших заявок и то, о чём уже сообщили соседи по дому.</p>
      </div>
    );
  }
  return (
    <div className="stack">
      {props.items.map((n) => {
        const fresh = new Date(n.at).getTime() > props.seenBefore;
        return (
          <section key={n.id} className={`card notif${fresh ? ' notif--new' : ''}${n.kind === 'neighbors' ? ' notif--neighbors' : ''}`}>
            <span className="field__label">
              {n.title} · {dateTime(n.at)}
            </span>
            <span className="field__value">{n.text}</span>
            {n.kind === 'status' && n.request_id && (
              <button className="linkish notif__action" onClick={() => props.onOpenRequest(n.request_id!)}>
                Открыть заявку
              </button>
            )}
            {n.kind === 'neighbors' && n.category && (
              <button className="linkish notif__action" onClick={() => props.onJoin(n.category!)}>
                У меня то же — подать заявку
              </button>
            )}
          </section>
        );
      })}
      <p className="note">Соседи видны только как количество заявок по категории — без текста, квартир и имён.</p>
    </div>
  );
}
