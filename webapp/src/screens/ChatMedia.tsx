import { useEffect, useRef, useState } from 'react';
import type { ChatAttachment } from '../api';
import { openExternal } from '../bridge';

/** Вложения в чате дома: голосовое, фото, файл — и запись голоса. */

export const fmtDuration = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const fmtSize = (b: number) =>
  b < 1024 ? `${b} Б` : b < 1024 * 1024 ? `${Math.round(b / 1024)} КБ` : `${(b / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;

// Одновременно играет только одно голосовое
let playing: HTMLAudioElement | null = null;

export function VoiceNote({ a }: { a: ChatAttachment }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const [pos, setPos] = useState(0);
  const [failed, setFailed] = useState(false);
  const total = a.duration || 0;

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    const el = ref.current;
    if (!el) return;
    if (on) {
      el.pause();
      return;
    }
    if (playing && playing !== el) playing.pause();
    playing = el;
    el.play().catch(() => setFailed(true));
  }

  const progress = total ? Math.min(1, pos / total) : 0;
  return (
    <div className="voice" onClick={(e) => e.stopPropagation()}>
      <button className="voice__btn" onClick={toggle} aria-label={on ? 'Пауза' : 'Прослушать голосовое'} disabled={failed}>
        {on ? (
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div className="voice__track" aria-hidden="true">
        <div className="voice__fill" style={{ width: `${progress * 100}%` }} />
      </div>
      <span className="voice__time">{failed ? 'не воспроизводится' : fmtDuration(on || pos ? pos : total)}</span>
      <audio
        ref={ref}
        src={a.url}
        preload="none"
        onPlay={() => setOn(true)}
        onPause={() => setOn(false)}
        onEnded={() => (setOn(false), setPos(0))}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        onError={() => (setFailed(true), setOn(false))}
      />
    </div>
  );
}

export function PhotoAttachment({ a, onOpen }: { a: ChatAttachment; onOpen: (url: string) => void }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <div className="msg__photo msg__photo--broken">Фото недоступно</div>;
  return (
    <button
      className="msg__photo-btn"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(a.url);
      }}
      aria-label="Открыть фото"
    >
      <img className="msg__photo" src={a.url} alt="Фото" loading="lazy" onError={() => setBroken(true)} />
    </button>
  );
}

export function FileAttachment({ a }: { a: ChatAttachment }) {
  const ext = (a.name ?? '').split('.').pop()?.toUpperCase().slice(0, 4) ?? '';
  return (
    <button
      className="msg__file"
      onClick={(e) => {
        e.stopPropagation();
        openExternal(a.url);
      }}
      aria-label={`Скачать файл ${a.name ?? ''}`}
    >
      <span className="msg__file-icon" aria-hidden="true">
        {ext || 'ФАЙЛ'}
      </span>
      <span className="msg__file-meta">
        <span className="msg__file-name">{a.name ?? 'Файл'}</span>
        <span className="msg__file-size">{fmtSize(a.size)} · скачать</span>
      </span>
    </button>
  );
}

export function PhotoViewer({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label="Фото" onClick={onClose}>
      <img src={url} alt="Фото" />
      <div className="viewer__bar" onClick={(e) => e.stopPropagation()}>
        <button className="viewer__btn" onClick={() => openExternal(url)}>
          Открыть в браузере
        </button>
        <button className="viewer__btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}

// ─── запись голоса ─────────────────────────────────────────────────────────

const TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];

export const canRecord = () =>
  typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof window.MediaRecorder !== 'undefined';

export type RecorderState = { kind: 'idle' } | { kind: 'starting' } | { kind: 'recording'; startedAt: number };

/**
 * Запись с микрофона через MediaRecorder. stop(send) — остановить и отдать запись (или выбросить).
 * Лимит длительности — maxSec: по достижении запись отправляется сама.
 */
export function useVoiceRecorder(maxSec: number, onDone: (blob: Blob, seconds: number) => void, onError: (msg: string) => void) {
  const [state, setState] = useState<RecorderState>({ kind: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<{ r: MediaRecorder; stream: MediaStream; chunks: Blob[]; startedAt: number; send: boolean } | null>(null);

  const release = () => {
    rec.current?.stream.getTracks().forEach((t) => t.stop());
    rec.current = null;
    setState({ kind: 'idle' });
    setElapsed(0);
  };

  async function start() {
    if (state.kind !== 'idle') return;
    setState({ kind: 'starting' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
      const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const cur = { r, stream, chunks: [] as Blob[], startedAt: Date.now(), send: false };
      r.ondataavailable = (e) => e.data.size && cur.chunks.push(e.data);
      r.onstop = () => {
        const secs = (Date.now() - cur.startedAt) / 1000;
        const blob = new Blob(cur.chunks, { type: r.mimeType || mimeType || 'audio/webm' });
        const send = cur.send;
        release();
        if (send && blob.size > 0 && secs >= 0.7) onDone(blob, secs);
      };
      rec.current = cur;
      r.start(250);
      setState({ kind: 'recording', startedAt: cur.startedAt });
    } catch (e) {
      release();
      const name = (e as { name?: string }).name;
      onError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Нет доступа к микрофону. Разрешите MAX доступ к микрофону в настройках телефона — или прикрепите запись файлом.'
          : 'Запись голоса недоступна на этом устройстве. Можно прикрепить готовую аудиозапись.',
      );
    }
  }

  function stop(send: boolean) {
    const cur = rec.current;
    if (!cur) return;
    cur.send = send;
    if (cur.r.state !== 'inactive') cur.r.stop();
    else release();
  }

  useEffect(() => {
    if (state.kind !== 'recording') return;
    const t = setInterval(() => {
      const s = (Date.now() - state.startedAt) / 1000;
      setElapsed(s);
      if (s >= maxSec) stop(true);
    }, 200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, maxSec]);

  // Ушли с экрана во время записи — микрофон выключаем, запись выбрасываем
  useEffect(() => () => {
    if (rec.current) {
      rec.current.send = false;
      rec.current.stream.getTracks().forEach((t) => t.stop());
      if (rec.current.r.state !== 'inactive') rec.current.r.stop();
    }
  }, []);

  return { state, elapsed, start, stop };
}

/** Длительность аудиофайла (для записи, прикреплённой файлом). 0 — не удалось узнать. */
export function audioDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const done = (v: number) => (URL.revokeObjectURL(url), resolve(Number.isFinite(v) ? v : 0));
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 4000);
    a.src = url;
  });
}
