import { Button } from '@maxhub/max-ui';
import type { Apartment as Apt } from '../api';
import { phoneHref } from '../format';
import { Field, orgName } from '../ui';

export function Apartment(props: { apartment: Apt | null; onWriteBot: () => void }) {
  const a = props.apartment;
  if (!a) {
    return (
      <div className="state">
        <h1>Квартира не привязана</h1>
        <p>Укажите адрес дома в чате с ботом — это нужно один раз. После этого здесь появятся данные дома и управляющей компании, и можно будет подавать заявки.</p>
        <Button size="medium" onClick={props.onWriteBot}>
          Открыть чат с ботом
        </Button>
      </div>
    );
  }
  const h = a.house;
  const uk = a.uk;
  const facts = [
    h.year_built && `${h.year_built} г. постройки`,
    h.floors && `${h.floors} эт.`,
    h.entrances && `${h.entrances} подъезд.`,
    h.apartments_count && `${h.apartments_count} кв.`,
  ].filter(Boolean);

  return (
    <div className="stack">
      <section className="card" aria-labelledby="apt-title">
        <h2 id="apt-title">{a.address}</h2>
        <span className="field__label">
          кв. {a.number}
          {a.entrance ? `, подъезд ${a.entrance}` : ''}
        </span>
        {facts.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Field label="Дом">{facts.join(' · ')}</Field>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="uk-title">
        <span className="field__label" id="uk-title">
          Управляющая компания
        </span>
        <div className="field__value" style={{ fontWeight: 600, margin: '2px 0 4px' }}>
          {uk ? orgName(uk) : 'Не указана в справочнике'}
        </div>
        {uk && !uk.verified && (
          <span className="field__label">Контакты покажем, как только сверим их с ГИС ЖКХ.</span>
        )}
        {uk?.dispatcher_phone && (
          <Field label="Аварийно-диспетчерская служба">
            <a className="linkish" href={phoneHref(uk.dispatcher_phone)}>
              {uk.dispatcher_phone}
            </a>
          </Field>
        )}
        {uk?.phone && (
          <Field label="Телефон УК">
            <a className="linkish" href={phoneHref(uk.phone)}>
              {uk.phone}
            </a>
          </Field>
        )}
        {uk?.working_hours && <Field label="Часы работы">{uk.working_hours}</Field>}
      </section>

      {!h.data_verified && <p className="note">Справочник домов работает в тестовом режиме.</p>}
      <p className="note">Сменить адрес — кнопкой «Сменить адрес» в чате с ботом.</p>
    </div>
  );
}
