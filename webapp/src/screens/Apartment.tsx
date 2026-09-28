import { Button } from '@maxhub/max-ui';
import type { Apartment as Apt } from '../api';
import { phoneHref } from '../format';
import { Field, orgName } from '../ui';

export function Apartment(props: { apartment: Apt | null; onChangeAddress: () => void; onJoinChat: (link: string) => void; onCreateChat: () => void }) {
  const a = props.apartment;
  if (!a) {
    return (
      <div className="state">
        <h1>Квартира не привязана</h1>
        <p>Укажите адрес дома — это нужно один раз. После этого здесь появятся данные дома и управляющей компании, и можно будет подавать заявки.</p>
        <Button size="medium" onClick={props.onChangeAddress}>
          Указать адрес
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
        {uk && (
          <div className="rating-row" style={{ margin: '0 0 6px' }}>
            {uk.rating ? (
              <>
                <span className="star star--on" aria-hidden="true">
                  ★
                </span>
                <span className="field__value">
                  <b>{uk.rating.avg.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</b> — оценка жильцов,{' '}
                  {uk.rating.count} {plural(uk.rating.count, 'оценка', 'оценки', 'оценок')}
                </span>
              </>
            ) : (
              <span className="field__label">Оценок жильцов пока нет — их ставят после выполнения заявки.</span>
            )}
          </div>
        )}
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

      {a.house_chat && (
        <section className="card" aria-labelledby="house-chat-title">
          <span className="field__label" id="house-chat-title">
            Чат дома в MAX
          </span>
          <div className="field__value" style={{ fontWeight: 600, margin: '2px 0 4px' }}>
            {a.house_chat.title ?? 'Чат соседей'}
          </div>
          <span className="field__label">Отключения, собрания, новости дома — вместе с соседями.</span>
          <div style={{ marginTop: 12 }}>
            <Button size="medium" stretched onClick={() => props.onJoinChat(a.house_chat!.link)}>
              Открыть чат дома
            </Button>
          </div>
        </section>
      )}

      {a.house_chat_state === 'none' && (
        <section className="card" aria-labelledby="house-chat-new">
          <span className="field__label" id="house-chat-new">
            Чат дома в MAX
          </span>
          <div className="field__value" style={{ margin: '2px 0 4px' }}>
            Чата вашего дома пока нет — бот создаст его. Вы станете владельцем, а соседям приложение предложит вступить.
          </div>
          <div style={{ marginTop: 12 }}>
            <Button size="medium" stretched onClick={props.onCreateChat}>
              Создать чат дома
            </Button>
          </div>
        </section>
      )}
      {a.house_chat_state === 'no_link' && (
        <section className="card">
          <span className="field__label">Чат дома в MAX</span>
          <div className="field__value" style={{ margin: '2px 0 0' }}>
            Чат дома создан. Как только владелец добавит ссылку-приглашение, здесь появится кнопка «Открыть чат дома».
          </div>
        </section>
      )}

      {!h.data_verified && <p className="note">Справочник домов работает в тестовом режиме.</p>}
      <div className="gutter">
        <Button size="large" variant="secondary" stretched onClick={props.onChangeAddress}>
          Сменить адрес
        </Button>
        <p className="note" style={{ margin: '8px 0 0', textAlign: 'center' }}>
          Уже поданные заявки останутся с прежним адресом.
        </p>
      </div>
    </div>
  );
}

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
