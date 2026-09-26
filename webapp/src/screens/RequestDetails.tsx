import { Button } from '@maxhub/max-ui';
import { useState } from 'react';
import { api, type RequestItem } from '../api';
import { dateTime } from '../format';
import { Field, orgName, StatusPill } from '../ui';
import { Photos } from './Photos';
import { Countdown, Timeline } from '../components';

/** Отзыв — в два шага: случайное нажатие не должно закрыть заявку. */
function CancelBlock({ onCancel }: { onCancel: () => Promise<string | null> }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (step === 'idle') {
    return (
      <div className="gutter">
        <Button size="medium" variant="secondary" stretched onClick={() => setStep('confirm')}>
          Отозвать заявку
        </Button>
      </div>
    );
  }
  return (
    <section className="card" aria-live="polite">
      <div className="field__value" style={{ fontWeight: 600 }}>Отозвать заявку?</div>
      <p className="field__label" style={{ margin: '4px 0 12px' }}>
        Это нельзя отменить. Если проблема вернётся, подайте новую заявку в чате с ботом.
      </p>
      {error && (
        <p className="field__value field__value--negative" style={{ margin: '0 0 12px', fontSize: 14 }}>
          {error}
        </p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Button size="medium" variant="secondary" disabled={step === 'busy'} onClick={() => (setStep('idle'), setError(null))}>
          Оставить
        </Button>
        <Button
          size="medium"
          variant="destructive"
          loading={step === 'busy'}
          onClick={async () => {
            setStep('busy');
            const err = await onCancel();
            if (err) {
              setError(err);
              setStep('confirm');
            }
          }}
        >
          Отозвать
        </Button>
      </div>
    </section>
  );
}

const RATING_WORD = ['', 'Плохо', 'Так себе', 'Нормально', 'Хорошо', 'Отлично'];

function Stars({ value, onPick, disabled }: { value: number; onPick?: (v: number) => void; disabled?: boolean }) {
  if (!onPick) {
    return (
      <span className="stars stars--static" role="img" aria-label={`${value} из 5`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`star${i <= value ? ' star--on' : ''}`} aria-hidden="true">
            ★
          </span>
        ))}
      </span>
    );
  }
  return (
    <div className="stars" role="radiogroup" aria-label="Оценка">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          role="radio"
          aria-checked={i === value}
          aria-label={`${i} из 5 — ${RATING_WORD[i]}`}
          className={`star${i <= value ? ' star--on' : ''}`}
          disabled={disabled}
          onClick={() => onPick(i)}
        >
          ★
        </button>
      ))}
    </div>
  );
}

/** Оценка после выполнения: звёзды и необязательный комментарий. Ставится один раз. */
function RatingBlock({ r, onUpdated }: { r: RequestItem; onUpdated: (r: RequestItem) => void }) {
  const [value, setValue] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (r.rating) {
    return (
      <section className="card" aria-labelledby="rating-title">
        <span id="rating-title" className="field__label">
          Ваша оценка
        </span>
        <div className="rating-row">
          <Stars value={r.rating.value} />
          <span className="field__value">{RATING_WORD[r.rating.value]}</span>
        </div>
        {r.rating.comment && <p className="field__value rating-comment">{r.rating.comment}</p>}
        <span className="field__label">Оценки жильцов видны в карточке управляющей компании на вкладке «Квартира».</span>
      </section>
    );
  }
  if (!r.can_rate) return null;

  async function send() {
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.rate(r.id, value, comment);
      if (res.request) onUpdated(res.request);
      else if (!res.ok) setError('Не удалось сохранить оценку.');
    } catch {
      setError('Нет связи с сервером. Попробуйте ещё раз.');
    }
    setBusy(false);
  }

  return (
    <section className="card" aria-labelledby="rate-title">
      <div id="rate-title" className="field__value" style={{ fontWeight: 600 }}>
        Как управляющая компания справилась?
      </div>
      <div className="rating-row">
        <Stars value={value} onPick={setValue} disabled={busy} />
        <span className="field__value">{RATING_WORD[value] ?? ''}</span>
      </div>
      {value > 0 && (
        <>
          <textarea
            className="input"
            rows={2}
            maxLength={500}
            placeholder={value <= 3 ? 'Что пошло не так? Необязательно' : 'Пара слов для соседей — необязательно'}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={busy}
            aria-label="Комментарий к оценке"
          />
          <Button size="medium" stretched loading={busy} onClick={() => void send()}>
            Отправить оценку
          </Button>
        </>
      )}
      {error && (
        <p className="field__value field__value--negative" style={{ margin: '8px 0 0', fontSize: 14 }} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** «Не решена»: готовый текст жалобы в ГЖИ с кнопкой «Скопировать». */
function ComplaintBlock({ id }: { id: string }) {
  const [data, setData] = useState<{ text: string; where: string; note: string } | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [copied, setCopied] = useState(false);

  async function load() {
    setState('loading');
    try {
      setData(await api.complaint(id));
      setState('idle');
    } catch {
      setState('error');
    }
  }
  async function copy() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.text);
      setCopied(true);
    } catch {
      // В части встроенных браузеров буфер обмена недоступен — выделяем текст, чтобы скопировать вручную
      const el = document.getElementById('complaint-text');
      if (el) window.getSelection()?.selectAllChildren(el);
    }
  }

  if (!data) {
    return (
      <div className="gutter">
        <Button size="medium" variant="secondary" stretched loading={state === 'loading'} onClick={() => void load()}>
          Не решена — жалоба в Госжилинспекцию
        </Button>
        {state === 'error' && <p className="note" style={{ margin: '8px 0 0' }}>Не удалось загрузить текст. Попробуйте ещё раз.</p>}
      </div>
    );
  }
  return (
    <section className="card" aria-labelledby="complaint-title">
      <div id="complaint-title" className="field__value" style={{ fontWeight: 600 }}>
        Жалоба в Госжилинспекцию РТ
      </div>
      <p className="field__label" style={{ margin: '4px 0 0' }}>
        Скопируйте текст и заполните поля в квадратных скобках. {data.note}
      </p>
      <div id="complaint-text" className="complaint">
        {data.text}
      </div>
      <Button size="medium" stretched onClick={() => void copy()}>
        {copied ? 'Скопировано' : 'Скопировать текст'}
      </Button>
      <p className="field__label" style={{ margin: '8px 0 0' }}>
        {data.where}
      </p>
    </section>
  );
}

export function RequestDetails({
  r,
  maxPhotos,
  onCancel,
  onResolve,
  onChanged,
  onUpdated,
}: {
  r: RequestItem;
  maxPhotos: number;
  onCancel: () => Promise<string | null>;
  onResolve: () => Promise<void>;
  onChanged: () => void;
  onUpdated: (r: RequestItem) => void;
}) {
  const [resolving, setResolving] = useState(false);
  const open = r.can_cancel;
  return (
    <div className="stack">
      <section className="card" aria-labelledby="req-title">
        <div className="req-title">
          <h2 id="req-title">{r.category_title}</h2>
          <StatusPill r={r} />
        </div>
        <span className="field__label">
          {r.number} · подана {dateTime(r.created_at)}
        </span>
      </section>

      <RatingBlock r={r} onUpdated={onUpdated} />

      <section className="card">
        <Field label="Проблема">{r.description}</Field>
        <Field label="Адрес">{r.address}</Field>
        <Field label="Ответственный">{r.org ? orgName(r.org) : 'Управляющая компания дома'}</Field>
      </section>

      <Photos requestId={r.id} photos={r.photos} canAdd={r.can_cancel} max={maxPhotos} onChanged={onChanged} />

      <section className="card">
        <Countdown r={r} />
        {r.norm && <Field label="Что должно произойти">{r.norm.what}</Field>}
        {r.norm && <Field label="Основание">{r.norm.ref}</Field>}
      </section>

      <Timeline r={r} />

      {r.can_resolve && (
        <div className="gutter">
          <Button
            size="medium"
            stretched
            loading={resolving}
            onClick={async () => {
              setResolving(true);
              await onResolve();
              setResolving(false);
            }}
          >
            Проблема решена
          </Button>
        </div>
      )}
      {r.can_complain && <ComplaintBlock id={r.id} />}
      {open && !r.overdue && (
        <p className="note">Если срок пройдёт, а проблема останется, бот напомнит в чате, а здесь появится готовый текст жалобы в Госжилинспекцию.</p>
      )}
      {r.status === 'cancelled' && <p className="note">Заявка отозвана — напоминаний по ней не будет.</p>}
      {open && <CancelBlock onCancel={onCancel} />}
      {r.status_is_demo && <p className="note">Статус показан в демо-режиме: он меняется по времени, пока УК не подключена к сервису.</p>}
      <p className="note">Тестовый режим: заявки хранятся в сервисе и в УК автоматически пока не передаются.</p>
    </div>
  );
}
