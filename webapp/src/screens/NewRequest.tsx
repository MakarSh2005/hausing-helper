import { Button } from '@maxhub/max-ui';
import { useEffect, useRef, useState } from 'react';
import { api, AuthError, type Apartment, type Catalog, type RequestItem } from '../api';
import { compressImage } from '../image';
import { orgName } from '../ui';

type Photo = { key: string; blob: Blob; url: string };

/**
 * Подача заявки: описание → категория (определяется сама, можно сменить) → фото → «Отправить».
 * Сначала создаётся заявка, потом по одному загружаются фото: заявка не теряется,
 * даже если какое-то фото не дошло (его можно добавить в карточке).
 */
export function NewRequest(props: {
  catalog: Catalog;
  apartment: Apartment;
  onCreated: (r: RequestItem, note: string | null) => void;
  onAuthError: (e: AuthError) => void;
}) {
  const { catalog, apartment } = props;
  const [text, setText] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [gas, setGas] = useState(false);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Категория по описанию — с задержкой, пока жилец печатает; ручной выбор не перебиваем.
  useEffect(() => {
    const t = text.trim();
    if (t.length < catalog.min_description) {
      setGas(false);
      return;
    }
    const timer = setTimeout(() => {
      api.suggest(t).then(
        (s) => {
          setGas(s.gas);
          if (!manual && s.category) setCategory(s.category);
        },
        () => {},
      );
    }, 500);
    return () => clearTimeout(timer);
  }, [text, manual, catalog.min_description]);

  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const cat = catalog.categories.find((c) => c.id === category) ?? null;
  const responsible = cat?.org_type === 'TKO' ? 'Региональный оператор по вывозу мусора (ТКО)' : apartment.uk ? orgName(apartment.uk) : 'Управляющая компания дома';
  const tooShort = text.trim().replace(/\s/g, '').length < catalog.min_description;
  const canSend = !tooShort && !!cat && !gas && !busy;

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const room = catalog.max_photos - photos.length;
    const picked = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic)$/i.test(f.name)).slice(0, room);
    setBusy('Обрабатываем фото…');
    const next: Photo[] = [];
    for (const f of picked) {
      const blob = await compressImage(f);
      next.push({ key: `${Date.now()}-${Math.random()}`, blob, url: URL.createObjectURL(blob) });
    }
    setPhotos((p) => [...p, ...next]);
    setBusy(null);
    setError(files.length > room ? `Можно приложить не больше ${catalog.max_photos} фото.` : null);
    if (fileRef.current) fileRef.current.value = '';
  }

  function removePhoto(key: string) {
    setPhotos((p) => {
      const x = p.find((y) => y.key === key);
      if (x) URL.revokeObjectURL(x.url);
      return p.filter((y) => y.key !== key);
    });
  }

  async function submit() {
    if (!canSend || !cat) return;
    setError(null);
    setBusy('Отправляем заявку…');
    try {
      const res = await api.create({ description: text, category: cat.id });
      if (!res.ok) {
        setBusy(null);
        setError(
          {
            gas: 'Похоже на запах газа — такую заявку не оформляем: звоните 104 или 112.',
            too_short: 'Опишите проблему чуть подробнее.',
            bad_category: 'Выберите категорию.',
            no_apartment: 'Квартира не привязана — укажите адрес в чате с ботом.',
          }[res.error],
        );
        return;
      }
      let failed = 0;
      for (const [i, p] of photos.entries()) {
        setBusy(`Загружаем фото ${i + 1} из ${photos.length}…`);
        try {
          if ((await api.uploadPhoto(res.request.id, p.blob)) !== 'ok') failed++;
        } catch (e) {
          if (e instanceof AuthError) throw e;
          failed++;
        }
      }
      const updated = photos.length ? await api.request(res.request.id).catch(() => res.request) : res.request;
      props.onCreated(
        updated,
        failed ? `Не загрузилось фото: ${failed}. Добавьте его в карточке заявки.` : null,
      );
    } catch (e) {
      setBusy(null);
      if (e instanceof AuthError) return props.onAuthError(e);
      setError('Нет связи с сервером. Проверьте интернет и нажмите «Отправить» ещё раз — дубля не будет.');
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <label className="field__label" htmlFor="problem">
          Что случилось и где
        </label>
        <textarea
          id="problem"
          className="input"
          rows={4}
          maxLength={catalog.max_description}
          placeholder="Например: течёт батарея в комнате, под окном мокро"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!!busy}
        />
        <span className="field__label">Адрес: {apartment.address}, кв. {apartment.number}</span>
      </section>

      {gas ? (
        <section className="card card--danger" role="alert">
          <div className="field__value" style={{ fontWeight: 600 }}>Запах газа — это опасно</div>
          <p className="field__value" style={{ margin: '6px 0 0', fontSize: 15 }}>
            Не включайте и не выключайте свет и приборы, не пользуйтесь огнём. Откройте окна, выйдите из помещения и позвоните
            в газовую службу: <a className="linkish" href="tel:104">104</a> или <a className="linkish" href="tel:112">112</a>.
            Заявку о газе через сервис не оформляем.
          </p>
        </section>
      ) : (
        <>
          <section className="card">
            <span className="field__label">
              Категория{cat && !manual ? ' — определена по описанию, можно сменить' : ''}
            </span>
            <div className="chips" role="radiogroup" aria-label="Категория">
              {catalog.categories.map((c) => (
                <button
                  key={c.id}
                  role="radio"
                  aria-checked={c.id === category}
                  className="chip"
                  disabled={!!busy}
                  onClick={() => {
                    setCategory(c.id);
                    setManual(true);
                  }}
                >
                  {c.title}
                </button>
              ))}
            </div>
          </section>

          <section className="card">
            <span className="field__label">
              Фото · {photos.length} из {catalog.max_photos}
            </span>
            <div className="photos">
              {photos.map((p, i) => (
                <div key={p.key} className="photo">
                  <img src={p.url} alt={`Фото ${i + 1}`} />
                  <button className="photo__remove" aria-label={`Убрать фото ${i + 1}`} onClick={() => removePhoto(p.key)} disabled={!!busy}>
                    ×
                  </button>
                </div>
              ))}
              {photos.length < catalog.max_photos && (
                <button className="photo photo--add" onClick={() => fileRef.current?.click()} disabled={!!busy}>
                  + Фото
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
          </section>

          {cat && (
            <section className="card">
              <div className="field">
                <span className="field__label">Кому</span>
                <span className="field__value">{responsible}</span>
              </div>
              <div className="field">
                <span className="field__label">Срок по нормативу</span>
                <span className="field__value">{cat.what}</span>
              </div>
              <div className="field">
                <span className="field__label">Основание</span>
                <span className="field__value">{cat.ref}</span>
              </div>
            </section>
          )}
        </>
      )}

      {error && (
        <p className="note" role="alert" style={{ color: 'var(--text-negative)' }}>
          {error}
        </p>
      )}
      {!gas && (
        <div className="gutter">
          <Button size="large" stretched disabled={!canSend} loading={!!busy && busy.startsWith('Отправляем')} onClick={() => void submit()}>
            Отправить заявку
          </Button>
          <p className="note" style={{ margin: '8px 0 0', textAlign: 'center' }} aria-live="polite">
            {busy ?? (tooShort ? 'Опишите проблему — хотя бы несколько слов' : !cat ? 'Выберите категорию' : ' ')}
          </p>
        </div>
      )}
    </div>
  );
}
