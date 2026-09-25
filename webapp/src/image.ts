/**
 * Сжатие фото перед отправкой: длинная сторона до 1600 px, JPEG ~0.82. Фото с телефона весит 3–8 МБ,
 * после сжатия — 200–500 КБ: быстрее по мобильному интернету и меньше места на сервере.
 * Если браузер не смог прочитать формат (например, HEIC на части Android) — отправляем как есть,
 * сервер сам проверит, что это картинка.
 */
const MAX_SIDE = 1600;

export async function compressImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob ?? file;
  } catch {
    return file;
  }
}
