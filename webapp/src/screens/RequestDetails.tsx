import { Button } from '@maxhub/max-ui';
import { useState } from 'react';
import { api, type RequestItem } from '../api';
import { dateTime } from '../format';
import { Field, orgName, StatusPill } from '../ui';
import { Photos } from './Photos';

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
}: {
  r: RequestItem;
  maxPhotos: number;
  onCancel: () => Promise<string | null>;
  onResolve: () => Promise<void>;
  onChanged: () => void;
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

      <section className="card">
        <Field label="Проблема">{r.description}</Field>
        <Field label="Адрес">{r.address}</Field>
        <Field label="Ответственный">{r.org ? orgName(r.org) : 'Управляющая компания дома'}</Field>
      </section>

      <Photos requestId={r.id} photos={r.photos} canAdd={r.can_cancel} max={maxPhotos} onChanged={onChanged} />

      <section className="card">
        <Field label={open ? (r.overdue ? 'Срок истёк' : 'Срок по нормативу') : 'Срок был'} negative={open && r.overdue}>
          до {dateTime(r.due_at)} (МСК)
        </Field>
        {r.norm && <Field label="Что должно произойти">{r.norm.what}</Field>}
        {r.norm && <Field label="Основание">{r.norm.ref}</Field>}
      </section>

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
