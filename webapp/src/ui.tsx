import { Button, Spinner } from '@maxhub/max-ui';
import type { ReactNode } from 'react';
import type { Org, RequestItem } from './api';

export function StatusPill({ r }: { r: Pick<RequestItem, 'status' | 'status_label' | 'overdue'> }) {
  if (r.overdue) return <span className="pill pill--overdue">срок истёк</span>;
  const tone = r.status === 'completed' ? 'pill--done' : r.status === 'rejected' || r.status === 'cancelled' ? '' : 'pill--active';
  return <span className={`pill ${tone}`}>{r.status_label}</span>;
}

export function Field({ label, children, negative }: { label: string; children: ReactNode; negative?: boolean }) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <span className={`field__value${negative ? ' field__value--negative' : ''}`}>{children}</span>
    </div>
  );
}

/** Название организации с честной пометкой о данных — как в боте. */
export function orgName(o: Org): string {
  return o.verified || o.demo ? o.name : `${o.name} (данные уточняются)`;
}

export function Loading({ label = 'Загружаем…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <Spinner size={28} appearance="themed" />
      <p>{label}</p>
    </div>
  );
}

export function StateScreen(props: { title: string; text: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="state">
      <h1>{props.title}</h1>
      <p>{props.text}</p>
      {props.action && (
        <Button size="medium" onClick={props.action.onClick}>
          {props.action.label}
        </Button>
      )}
    </div>
  );
}
