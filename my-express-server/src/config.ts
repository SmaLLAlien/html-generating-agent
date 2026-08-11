function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Рабочий бюджет контекста. Это не физическое окно модели (у gemini-2.5 оно ~1M),
 * а порог, на котором мы считаем историю раздутой: на 80% предупреждаем
 * пользователя, на 100% блокируем диалог и предлагаем начать новый.
 * Автосжатие истории сознательно не делается — см. docs/agent-architecture.md.
 */
export const CONTEXT_BUDGET_TOKENS = readInt('CONTEXT_BUDGET_TOKENS', 300_000);

/** Доля бюджета, на которой показываем предупреждение */
export const CONTEXT_WARN_RATIO = 0.8;

/** Максимум шагов агентного цикла за один ход пользователя */
export const MAX_AGENT_STEPS = readInt('MAX_AGENT_STEPS', 6);

/**
 * Потолок выходных токенов на шаг. Без него ответ ограничен только дефолтом
 * модели, и обрыв по длине становится незаметным: генерация просто обрывается
 * на полуслове. С явным лимитом мы хотя бы знаем, где именно упёрлись.
 */
export const MAX_OUTPUT_TOKENS = readInt('MAX_OUTPUT_TOKENS', 32_000);

/**
 * Сколько сессий держим в памяти. Создание сессии никак не аутентифицировано,
 * поэтому без потолка цикл запросов просто съедает heap. При переполнении
 * вытесняем самую давно неактивную.
 */
export const MAX_SESSIONS = readInt('MAX_SESSIONS', 500);

/**
 * Потолок вариантов в одной сессии. Каждый держит до 100 КБ HTML до конца
 * сессии, и вытеснение их не трогает — оно чистит историю, а не реестр.
 */
export const MAX_VARIANTS_PER_SESSION = readInt('MAX_VARIANTS_PER_SESSION', 50);

/** Ограничение длины сообщения пользователя, символов */
export const MAX_MESSAGE_LENGTH = readInt('MAX_MESSAGE_LENGTH', 8_000);

/**
 * Размер одной картинки после ужатия на клиенте, байт. Клиент приводит длинную
 * сторону к 1024px и перекодирует в JPEG, поэтому 4 МБ — щедрый запас; лимит
 * тут стоит на случай, если ужатие обошли.
 */
export const MAX_ATTACHMENT_BYTES = readInt('MAX_ATTACHMENT_BYTES', 4 * 1024 * 1024);

/** Сколько картинок можно приложить к одному сообщению */
export const MAX_ATTACHMENTS_PER_MESSAGE = readInt('MAX_ATTACHMENTS_PER_MESSAGE', 4);

/**
 * Потолок вложений на сессию. Как и варианты, они живут до конца диалога:
 * вытеснение убирает их из контекста модели, но не из реестра.
 */
export const MAX_ATTACHMENTS_PER_SESSION = readInt('MAX_ATTACHMENTS_PER_SESSION', 20);

/**
 * Лимит тела для маршрута загрузки. Стоит отдельно от общего 1 МБ: поднимать
 * общий нельзя — сессии не аутентифицированы, и большой парсер на всех
 * маршрутах это новая поверхность для отказа в обслуживании.
 */
export const ATTACHMENT_BODY_LIMIT = process.env.ATTACHMENT_BODY_LIMIT ?? '8mb';
