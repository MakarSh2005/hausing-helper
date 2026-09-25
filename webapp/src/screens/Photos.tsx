import { useEffect, useState } from 'react';
import { api } from '../api';

type Thumb = { id: string; url: string | null; state: 'loading' | 'ok' | 'missing' };

/** Фото заявки: миниатюры, по нажатию — на весь экран. */
export function Photos({ requestId, photos }: { requestId: string; photos: Array<{ id: string; available: boolean }> }) {
  const [thumbs, setThumbs] = useState<Thumb[]>(() =>
    photos.map((p) => ({ id: p.id, url: null, state: p.available ? 'loading' : 'missing' })),
  );
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    for (const p of photos.filter((x) => x.available)) {
      api.photo(requestId, p.id).then(
        (blob) => {
          const url = URL.createObjectURL(blob);
          urls.push(url);
          if (alive) setThumbs((t) => t.map((x) => (x.id === p.id ? { ...x, url, state: 'ok' } : x)));
        },
        () => alive && setThumbs((t) => t.map((x) => (x.id === p.id ? { ...x, state: 'missing' } : x))),
      );
    }
    return () => {
      alive = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [requestId, photos]);

  if (photos.length === 0) return null;
  const big = thumbs.find((t) => t.id === open && t.url);

  return (
    <section className="card" aria-label="Фото">
      <span className="field__label">Фото · {photos.length}</span>
      <div className="photos">
        {thumbs.map((t, i) => (
          <button
            key={t.id}
            className="photo"
            disabled={t.state !== 'ok'}
            onClick={() => setOpen(t.id)}
            aria-label={`Фото ${i + 1}${t.state === 'missing' ? ' недоступно' : ''}`}
          >
            {t.state === 'ok' && t.url ? <img src={t.url} alt="" /> : <span>{t.state === 'loading' ? '…' : 'нет файла'}</span>}
          </button>
        ))}
      </div>
      {thumbs.some((t) => t.state === 'missing') && (
        <p className="field__label" style={{ margin: '8px 0 0' }}>
          Часть фото не удалось сохранить — они остались в чате с ботом.
        </p>
      )}
      {big && (
        <div className="viewer" role="dialog" aria-label="Фото на весь экран" onClick={() => setOpen(null)}>
          <img src={big.url!} alt="" />
          <span className="viewer__hint">Нажмите, чтобы закрыть</span>
        </div>
      )}
    </section>
  );
}
