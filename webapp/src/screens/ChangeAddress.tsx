import { Button } from '@maxhub/max-ui';
import { useEffect, useState } from 'react';
import { api, AuthError, type Apartment, type HouseHit, type HouseSearch } from '../api';

/**
 * Смена адреса в приложении — то же, что «Сменить адрес» в боте: поиск по справочнику → дом →
 * квартира и подъезд. Уже поданные заявки остаются с адресом, с которым их подавали.
 */
export function ChangeAddress(props: {
  current: Apartment | null;
  onSaved: (a: Apartment) => void;
  onCancel: () => void;
  onAuthError: (e: AuthError) => void;
}) {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<HouseSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [house, setHouse] = useState<HouseHit | null>(null);
  const [number, setNumber] = useState('');
  const [entrance, setEntrance] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Поиск по мере ввода, с небольшой задержкой
  useEffect(() => {
    if (house) return;
    const t = q.trim();
    if (t.length < 2) {
      setResult(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      api.searchHouses(t).then(
        (r) => {
          setResult(r);
          setSearching(false);
          if (r.apartment && !number) setNumber(r.apartment);
        },
        (e) => {
          setSearching(false);
          if (e instanceof AuthError) props.onAuthError(e);
          else setError('Нет связи с сервером. Попробуйте ещё раз.');
        },
      );
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, house]);

  async function save() {
    if (!house) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.setApartment({ house_id: house.id, number, entrance });
      if (r.ok) return props.onSaved(r.apartment);
      setError(
        {
          bad_number: 'Номер квартиры — цифрами, например 42 или 15а.',
          bad_entrance: 'В этом доме нет такого подъезда.',
          bad_house: 'Этот дом больше не найден в справочнике — выберите заново.',
        }[r.error] ?? 'Не удалось сохранить адрес.',
      );
    } catch (e) {
      if (e instanceof AuthError) return props.onAuthError(e);
      setError('Нет связи с сервером. Попробуйте ещё раз.');
    } finally {
      setSaving(false);
    }
  }

  const entrances = house?.entrances && house.entrances >= 2 && house.entrances <= 12 ? house.entrances : 0;
  const hint =
    result?.kind === 'not_found'
      ? `Такого адреса нет в справочнике. Сейчас в нём ${result.total} домов в нескольких районах Казани — проверьте написание.`
      : result?.kind === 'no_number'
        ? `${result.street}: такого номера нет. Выберите свой дом из списка:`
        : result?.kind === 'need_number'
          ? `${result.street}: выберите номер дома или допишите его.`
          : result?.kind === 'found' && result.houses.length > 1
            ? 'Несколько корпусов — выберите свой:'
            : null;

  return (
    <div className="stack">
      {props.current && (
        <p className="note" style={{ marginTop: 0 }}>
          Сейчас: {props.current.address}, кв. {props.current.number}. Уже поданные заявки останутся с прежним адресом.
        </p>
      )}

      {!house ? (
        <section className="card">
          <label className="field__label" htmlFor="addr">
            Улица и номер дома
          </label>
          <input
            id="addr"
            className="input"
            placeholder="Например: Ибрагимова 12"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            autoFocus
          />
          {searching && <span className="field__label">Ищем в справочнике…</span>}
          {!searching && hint && <p className="field__label" style={{ margin: '4px 0 0' }}>{hint}</p>}
          {!searching && result && result.houses.length > 0 && (
            <div className="house-list">
              {result.houses.map((h) => (
                <button key={h.id} className="house-hit" onClick={() => setHouse(h)}>
                  <span className="field__value" style={{ fontWeight: 600 }}>
                    {h.address}
                  </span>
                  <span className="field__label">
                    {h.uk ? `${h.uk.name}${h.uk.verified ? '' : ' (данные уточняются)'}` : 'УК не указана в справочнике'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="card">
          <span className="field__label">Дом найден в справочнике</span>
          <div className="field__value" style={{ fontWeight: 600, margin: '2px 0 8px' }}>
            {house.address}
          </div>
          <button className="linkish notif__action" style={{ marginTop: 0 }} onClick={() => (setHouse(null), setEntrance(null))}>
            Другой дом
          </button>

          <label className="field__label" htmlFor="apt" style={{ display: 'block', marginTop: 12 }}>
            Номер квартиры
          </label>
          <input id="apt" className="input" inputMode="numeric" placeholder="42" value={number} onChange={(e) => setNumber(e.target.value)} />

          {entrances > 0 && (
            <>
              <span className="field__label">Подъезд — поможет УК быстрее вас найти</span>
              <div className="chips" role="radiogroup" aria-label="Подъезд">
                {Array.from({ length: entrances }, (_, i) => i + 1).map((n) => (
                  <button key={n} role="radio" aria-checked={entrance === n} className="chip" onClick={() => setEntrance(entrance === n ? null : n)}>
                    {n}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {error && (
        <p className="note" role="alert" style={{ color: 'var(--text-negative)' }}>
          {error}
        </p>
      )}
      <div className="gutter stack" style={{ gap: 8 }}>
        {house && (
          <Button size="large" stretched loading={saving} disabled={!number.trim()} onClick={() => void save()}>
            Сохранить адрес
          </Button>
        )}
        {props.current && (
          <Button size="medium" variant="secondary" stretched onClick={props.onCancel} disabled={saving}>
            Оставить прежний адрес
          </Button>
        )}
      </div>
    </div>
  );
}
