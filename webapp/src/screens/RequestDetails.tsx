import { Button } from '@maxhub/max-ui';
import { useState } from 'react';
import type { RequestItem } from '../api';
import { dateTime } from '../format';
import { Field, orgName, StatusPill } from '../ui';

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

export function RequestDetails({ r, onCancel }: { r: RequestItem; onCancel: () => Promise<string | null> }) {
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

      <section className="card">
        <Field label={open ? (r.overdue ? 'Срок истёк' : 'Срок по нормативу') : 'Срок был'} negative={open && r.overdue}>
          до {dateTime(r.due_at)} (МСК)
        </Field>
        {r.norm && <Field label="Что должно произойти">{r.norm.what}</Field>}
        {r.norm && <Field label="Основание">{r.norm.ref}</Field>}
      </section>

      {open && r.overdue && (
        <p className="note">Бот пришлёт в чат вопрос «Проблема решена?», а если нет — поможет составить жалобу в Госжилинспекцию.</p>
      )}
      {r.status === 'cancelled' && <p className="note">Заявка отозвана — напоминаний по ней не будет.</p>}
      {open && <CancelBlock onCancel={onCancel} />}
      {r.status_is_demo && <p className="note">Статус показан в демо-режиме: он меняется по времени, пока УК не подключена к сервису.</p>}
      <p className="note">Тестовый режим: заявки хранятся в сервисе и в УК автоматически пока не передаются.</p>
    </div>
  );
}
