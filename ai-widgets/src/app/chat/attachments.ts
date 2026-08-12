/**
 * Подготовка картинок к отправке.
 *
 * Ужатие делается на клиенте намеренно. Gemini считает картинку плитками
 * 768×768 по 258 токенов, поэтому нетронутый скриншот с большого монитора
 * стоит вдвое дороже ужатого и переотправляется на каждом шаге хода. Приведение
 * длинной стороны к 1024px делает цену предсказуемой и не зависящей от того,
 * чем пользователь сделал снимок.
 *
 * Побочная выгода: то же самое data URL идёт и в запрос, и в превью в ленте —
 * один артефакт на две задачи, без возни с временем жизни object URL.
 */

/** Длинная сторона после ужатия */
const MAX_EDGE = 1024;
/** Качество JPEG: выше 0.85 растёт вес без заметной разницы для скриншотов */
const JPEG_QUALITY = 0.85;
/** Что принимаем: HEIC не берём — браузер не покажет его в превью */
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** Ограничение на исходный файл до ужатия */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export interface PreparedImage {
  name: string;
  mediaType: string;
  /** data:image/...;base64,... — идёт и в запрос, и в <img src> */
  dataUrl: string;
  sizeBytes: number;
}

export function isSupportedImage(file: File): boolean {
  return ACCEPTED_TYPES.includes(file.type);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось прочитать изображение'));
    img.src = url;
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

/** Примерный вес data URL в байтах: base64 весит на треть больше данных */
function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.round((base64.length * 3) / 4);
}

/**
 * Читает файл, ужимает и отдаёт data URL.
 * Если картинка уже меньше порога — оставляем исходную, чтобы не терять
 * качество PNG-скриншота лишним перекодированием в JPEG.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!isSupportedImage(file)) {
    throw new Error('Поддерживаются только PNG, JPEG и WebP');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('Файл больше 25 МБ');
  }

  const original = await readAsDataUrl(file);
  const img = await loadImage(original);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);

  if (longest <= MAX_EDGE) {
    return {
      name: file.name,
      mediaType: file.type,
      dataUrl: original,
      sizeBytes: dataUrlBytes(original),
    };
  }

  const scale = MAX_EDGE / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Браузер не дал холст для сжатия');
  // Белая подложка: у PNG с прозрачностью иначе получится чёрный фон в JPEG
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return {
    name: file.name,
    mediaType: 'image/jpeg',
    dataUrl,
    sizeBytes: dataUrlBytes(dataUrl),
  };
}

/** Достаёт файлы-картинки из события вставки или перетаскивания */
export function imagesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files).filter(isSupportedImage);
}
