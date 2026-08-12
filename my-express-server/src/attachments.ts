import { MAX_ATTACHMENT_BYTES } from './config.js';

/**
 * Типы, которые умеет и Gemini, и браузер.
 *
 * HEIC/HEIF Gemini принимает, но браузер не покажет превью — а картинка должна
 * быть видна пользователю в ленте, поэтому в белый список он не входит.
 */
const ALLOWED_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export interface ParsedAttachment {
  name: string;
  mediaType: string;
  data: Buffer;
  sizeBytes: number;
}

export type ParseResult =
  | { ok: true; value: ParsedAttachment }
  | { ok: false; error: string };

/** Убираем префикс data: URL, если клиент прислал целиком */
function stripDataUrlPrefix(raw: string): string {
  const comma = raw.indexOf(',');
  return raw.startsWith('data:') && comma !== -1 ? raw.slice(comma + 1) : raw;
}

/**
 * Оценка стоимости картинки в токенах по правилам Gemini: 258 токенов, если обе
 * стороны ≤384px, иначе изображение режется на плитки 768×768 по 258 токенов.
 *
 * Размеры мы тут не разбираем (это требовало бы декодера), поэтому считаем по
 * объёму данных — грубо, но достаточно, чтобы предупредить пользователя о цене.
 */
export function estimateImageTokens(sizeBytes: number): number {
  const TILE_TOKENS = 258;
  // Ужатый до 1024px JPEG обычно 80-250 КБ и укладывается в 4-6 плиток
  const approxTiles = Math.max(1, Math.round(sizeBytes / 45_000));
  return Math.min(approxTiles, 12) * TILE_TOKENS;
}

/**
 * Разбирает и проверяет вложение из тела запроса.
 * Возвращает результат, а не бросает: ошибки тут ожидаемые, а не исключительные.
 */
export function parseAttachment(body: unknown): ParseResult {
  const { name, mediaType, dataBase64 } = (body ?? {}) as {
    name?: unknown;
    mediaType?: unknown;
    dataBase64?: unknown;
  };

  if (typeof mediaType !== 'string' || !ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return {
      ok: false,
      error: 'Поддерживаются только PNG, JPEG и WebP',
    };
  }
  if (typeof dataBase64 !== 'string' || !dataBase64.trim()) {
    return { ok: false, error: 'Пустое вложение' };
  }

  let data: Buffer;
  try {
    data = Buffer.from(stripDataUrlPrefix(dataBase64), 'base64');
  } catch {
    return { ok: false, error: 'Не удалось прочитать файл' };
  }

  // Buffer.from не бросает на мусоре, а молча отдаёт огрызок — проверяем результат
  if (data.length === 0) {
    return { ok: false, error: 'Файл повреждён или пуст' };
  }
  if (data.length > MAX_ATTACHMENT_BYTES) {
    const mb = (MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0);
    return { ok: false, error: `Файл больше ${mb} МБ` };
  }
  if (!looksLikeDeclaredType(data, mediaType)) {
    return {
      ok: false,
      error: 'Содержимое файла не совпадает с его типом',
    };
  }

  const safeName =
    typeof name === 'string' && name.trim()
      ? name.trim().slice(0, 120)
      : 'изображение';

  return {
    ok: true,
    value: { name: safeName, mediaType, data, sizeBytes: data.length },
  };
}

/**
 * Сверяем сигнатуру файла с заявленным типом: клиент мог соврать в mediaType,
 * а Gemini доверяет ему без проверок.
 */
function looksLikeDeclaredType(data: Buffer, mediaType: string): boolean {
  if (data.length < 12) return false;

  const isPng =
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  const isJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const isWebp =
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP';

  switch (mediaType) {
    case 'image/png':
      return isPng;
    case 'image/jpeg':
      return isJpeg;
    case 'image/webp':
      return isWebp;
    default:
      return false;
  }
}
