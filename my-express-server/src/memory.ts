import type { ModelMessage } from 'ai';
import type { ChatSession, WidgetVariant } from './sessions.js';

/**
 * Вытеснение артефактов из истории (ступень 0).
 *
 * Полный HTML виджета попадает в контекст в двух местах:
 *   1) аргументом вызова emitWidget  — assistant-сообщение, part.input.html
 *   2) результатом вызова getVariant — tool-сообщение, part.output.value
 *
 * Оба заменяются короткой заглушкой у всех вариантов, кроме закреплённых.
 * Сам код никуда не девается — он лежит в session.variants и достаётся
 * инструментом getVariant. Благодаря этому размер истории перестаёт расти
 * с числом итераций и выходит на плато.
 *
 * Переписываем НА МЕСТЕ, а не пересобираем историю проекцией: так меняется
 * только хвост, а стабильный префикс остаётся пригодным для кеша Gemini.
 */

/** Метка, по которой видно, что кусок уже вытеснен — повторно не трогаем */
const STUB_MARK = '⟨вытеснено⟩';

function emitStub(variant: WidgetVariant | undefined, toolCallId: string): string {
  if (!variant) {
    return `${STUB_MARK} Код этого виджета вытеснен из контекста (вызов ${toolCallId}).`;
  }
  return (
    `${STUB_MARK} Код варианта #${variant.n} «${variant.title}» вытеснен из контекста. ` +
    `Чтобы получить его целиком — вызови getVariant(${variant.n}).`
  );
}

function fetchStub(n: number | null): string {
  return n != null
    ? `${STUB_MARK} Код варианта #${n} был получен ранее и вытеснен из контекста. ` +
        `Если он снова нужен — вызови getVariant(${n}).`
    : `${STUB_MARK} Ранее полученный код вытеснен из контекста.`;
}

export interface EvictionStats {
  /** Сколько кусков заменено заглушками за этот проход */
  evicted: number;
  /** Сколько символов освобождено */
  freedChars: number;
  /** Номера вариантов, оставшихся в контексте с полным кодом */
  pinned: number[];
}

/**
 * Какие варианты остаются в контексте целиком:
 * последний (над ним идёт работа) и принятый (на него ссылаются при завершении).
 *
 * Вариант, который агент запрашивал в этом ходе, закреплять не нужно: если он
 * что-то на его основе сделал, результат уже стал последним вариантом.
 */
function pinnedVariants(session: ChatSession): Set<number> {
  const pinned = new Set<number>();
  const latest = session.variants.at(-1);
  if (latest) pinned.add(latest.n);
  for (const v of session.variants) {
    if (v.accepted) pinned.add(v.n);
  }
  return pinned;
}

/**
 * Вытеснение картинок из пользовательских сообщений.
 *
 * Без этого приложенная картинка оставалась бы в истории до конца сессии и
 * переотправлялась на каждом ходу И на каждом шаге внутри хода — скриншот
 * 1920×1080 стоит около 1500 токенов, так что рост был бы быстрым. Это ровно
 * та же проблема, что решает вытеснение кода виджетов, только через другую дверь.
 *
 * Полным остаётся ТОЛЬКО последний набор картинок: над ним идёт работа. Всё
 * старше заменяется текстовой пометкой, а сами данные лежат в реестре сессии и
 * достаются инструментом getAttachment.
 */
function evictImages(session: ChatSession, stats: EvictionStats): void {
  // Ищем последнее пользовательское сообщение с картинками — оно закреплено
  let lastWithImages = -1;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]!;
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    if (message.content.some((p) => p.type === 'image')) {
      lastWithImages = i;
      break;
    }
  }

  // Порядок картинок в истории совпадает с порядком в реестре — по нему и
  // восстанавливаем имя с идентификатором для пометки
  let seen = 0;

  for (let i = 0; i < session.messages.length; i++) {
    const message = session.messages[i]!;
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;

    const parts = message.content;
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j]!;
      if (part.type !== 'image') continue;

      const info = session.attachments[seen];
      seen++;
      if (i === lastWithImages) continue; // закреплено

      const label = info
        ? `«${info.name}» (id ${info.id}). Посмотреть снова — инструментом getAttachment("${info.id}")`
        : 'без идентификатора';
      const before =
        part.image instanceof Uint8Array ? part.image.length : String(part.image).length;
      const stub = `${STUB_MARK} Изображение ${label} убрано из контекста.`;

      parts[j] = { type: 'text', text: stub };
      stats.evicted++;
      // base64 в запросе примерно на треть больше исходных байт
      stats.freedChars += Math.round(before * 1.37) - stub.length;
    }
  }
}

export function evictOldWidgets(session: ChatSession): EvictionStats {
  const pinned = pinnedVariants(session);
  const byToolCallId = new Map<string, WidgetVariant>();
  for (const v of session.variants) {
    if (v.toolCallId) byToolCallId.set(v.toolCallId, v);
  }

  // Первый проход: собираем, какой вариант запрашивал каждый вызов getVariant,
  // чтобы заглушка на его результате могла назвать номер.
  const fetchedBy = new Map<string, number>();
  for (const message of session.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part.type === 'tool-call' &&
        part.toolName === 'getVariant' &&
        part.input &&
        typeof (part.input as { n?: unknown }).n === 'number'
      ) {
        fetchedBy.set(part.toolCallId, (part.input as { n: number }).n);
      }
    }
  }

  const stats: EvictionStats = {
    evicted: 0,
    freedChars: 0,
    pinned: [...pinned].sort((a, b) => a - b),
  };

  evictImages(session, stats);

  for (const message of session.messages) {
    if (!Array.isArray(message.content)) continue;

    for (const part of message.content) {
      // 1) Аргумент emitWidget
      if (part.type === 'tool-call' && part.toolName === 'emitWidget') {
        const input = part.input as { html?: unknown } | undefined;
        if (!input || typeof input.html !== 'string') continue;
        if (input.html.startsWith(STUB_MARK)) continue;

        const variant = byToolCallId.get(part.toolCallId);
        if (variant && pinned.has(variant.n)) continue;

        const stub = emitStub(variant, part.toolCallId);
        stats.freedChars += input.html.length - stub.length;
        stats.evicted++;
        // Заменяем объект целиком: чужие структуры лучше не мутировать по полю
        (part as { input: unknown }).input = { ...input, html: stub };
        continue;
      }

      // 2) Результат getVariant
      if (part.type === 'tool-result' && part.toolName === 'getVariant') {
        const output = part.output as { type?: string; value?: unknown };
        if (output?.type !== 'text' || typeof output.value !== 'string') continue;
        if (output.value.startsWith(STUB_MARK)) continue;

        const n = fetchedBy.get(part.toolCallId) ?? null;
        // Если запрошенный вариант закреплён, его полный код и так в контексте —
        // но именно эта копия дублирующая, поэтому вытесняем в любом случае.
        const stub = fetchStub(n);
        stats.freedChars += output.value.length - stub.length;
        stats.evicted++;
        (part as { output: unknown }).output = { type: 'text', value: stub };
      }
    }
  }

  return stats;
}

/** Приблизительный размер истории в символах — для логов и диагностики */
export function historySize(messages: ModelMessage[]): number {
  return JSON.stringify(messages).length;
}
