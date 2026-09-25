import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { compressImage } from '../image';

type Thumb = { id: string; url: string | null; state: 'loading' | 'ok' | 'missing' };

/** Фото заявки: миниатюры, по нажатию — на весь экран; к открытой заявке можно добавить ещё. */
export function Photos(props: {
  requestId: string;
  photos: Array<{ id: string; available: boolean }>;
  canAdd: boolean;
  max: number;
  onChanged: () => void;
}) {
  const { requestId, photos } = props;
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    setThumbs(photos.map((p) => ({ id: p.id, url: null, state: p.available ? 'loading' : 'missing' })));
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

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    let failed = 0;
    for (const f of [...files].slice(0, props.max - photos.length)) {
      try {
        if ((await api.uploadPhoto(requestId, await compressImage(f))) !== 'ok') failed++;
      } catch {
        failed++;
      }
    }
    setUploading(false);
    if (failed) setError(`Не удалось загрузить фото: ${failed}.`);
    if (fileRef.current) fileRef.current.value = '';
    props.onChanged();
  }

  if (photos.length === 0 && !props.canAdd) return null;
  const big = thumbs.find((t) => t.id === open && t.url);
  const room = props.canAdd && photos.length < props.max;

  return (
    <section className="card" aria-label="Фото">
      <span className="field__label">
        Фото · {photos.length}
        {props.canAdd ? ` из ${props.max}` : ''}
      </span>
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
        {room && (
          <button className="photo photo--add" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? '…' : '+ Фото'}
          </button>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void add(e.target.files)} />
      {error && (
        <p className="field__label" style={{ margin: '8px 0 0', color: 'var(--text-negative)' }}>
          {error}
        </p>
      )}
      {thumbs.some((t) => t.state === 'missing') && (
        <p className="field__label" style={{ margin: '8px 0 0' }}>
          Часть фото не удалось сохранить.
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
