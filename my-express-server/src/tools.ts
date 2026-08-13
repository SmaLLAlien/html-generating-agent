import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { EmitEvent } from './events.js';
import {
  addVariant,
  canAddVariant,
  getAttachment,
  getVariant,
  type ChatSession,
} from './sessions.js';

/** Подстраховка: вырезаем любой JavaScript, если проверка что-то пропустила */
export function stripJavaScript(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

const FORBIDDEN: ReadonlyArray<{ re: RegExp; problem: string }> = [
  { re: /<script\b/i, problem: 'тег <script>' },
  {
    re: /\son\w+\s*=/i,
    problem: 'атрибут-обработчик события (onclick, onload и т.п.)',
  },
  { re: /javascript:/i, problem: 'ссылка javascript:' },
  { re: /<iframe\b/i, problem: 'тег <iframe>' },
  { re: /<object\b/i, problem: 'тег <object>' },
  { re: /<embed\b/i, problem: 'тег <embed>' },
];

const MAX_WIDGET_LENGTH = 100_000;

/**
 * Проверяем ИСХОДНЫЙ html и при нарушении возвращаем ошибку модели, чтобы она
 * переделала сама. Молча вырезать запрещённое нельзя — так ломается вёрстка.
 */
export function validateWidget(html: string): string[] {
  const problems: string[] = [];
  if (!html.trim()) {
    problems.push('пустой код');
    return problems;
  }
  if (html.length > MAX_WIDGET_LENGTH) {
    problems.push(`код слишком длинный (${html.length} символов)`);
  }
  for (const { re, problem } of FORBIDDEN) {
    if (re.test(html)) problems.push(problem);
  }
  return problems;
}

/**
 * Инструменты агента. Создаются на каждый ход, потому что замкнуты на сессию
 * и на функцию отправки событий клиенту.
 */
export function buildTools(session: ChatSession, emit: EmitEvent): ToolSet {
  return {
    emitWidget: tool({
      description:
        'Показать пользователю новую версию виджета. Вызывай ВСЕГДА, когда создаёшь ' +
        'или изменяешь виджет — это единственный способ его показать. Код должен быть ' +
        'полным и самодостаточным (не диф, не фрагмент изменений).',
      inputSchema: z.object({
        html: z
          .string()
          .describe(
            'Полный самодостаточный HTML+CSS виджета. Без JavaScript: запрещены <script>, ' +
              'атрибуты on*, javascript:, <iframe>, <object>, <embed>. Стили — инлайновые ' +
              'или в теге <style> внутри виджета.'
          ),
        title: z
          .string()
          .describe(
            'Короткое название варианта, 3–5 слов. Например: «Карточка с тёмной шапкой».'
          ),
        basedOn: z
          .number()
          .int()
          .nullable()
          .describe(
            'Номер варианта, который ты дорабатывал. null — если делаешь виджет с нуля.'
          ),
      }),
      // HTML генерируется долго — сразу говорим клиенту, что идёт сборка
      onInputStart: () => emit({ type: 'status', stage: 'widget-start' }),
      execute: async ({ html, title, basedOn }, { toolCallId }) => {
        if (!canAddVariant(session)) {
          return {
            ok: false as const,
            problems: [
              'достигнут предел числа вариантов в диалоге — предложи пользователю начать новый',
            ],
          };
        }

        const problems = validateWidget(html);
        if (problems.length) {
          return { ok: false as const, problems };
        }

        const clean = stripJavaScript(html);
        const parent =
          basedOn != null && getVariant(session, basedOn) ? basedOn : null;
        const variant = addVariant(session, {
          html: clean,
          title: title.trim(),
          basedOn: parent,
          toolCallId,
        });

        emit({
          type: 'widget',
          variant: variant.n,
          title: variant.title,
          basedOn: variant.basedOn,
          html: variant.html,
        });

        return { ok: true as const, variant: variant.n };
      },
      /**
       * Модели возвращается только номер — HTML в результат не попадает никогда.
       * Это и есть встроенное вытеснение: код живёт в контексте ровно один раз,
       * как аргумент вызова, и не дублируется результатом.
       */
      toModelOutput: ({ output }) =>
        output.ok
          ? {
              type: 'text',
              value: `Вариант #${output.variant} сохранён и показан пользователю. Ссылайся на него по номеру.`,
            }
          : {
              type: 'error-text',
              value:
                `Виджет отклонён, пользователю он НЕ показан. Нарушения: ${output.problems.join(', ')}. ` +
                'Исправь код и вызови emitWidget заново.',
            },
    }),

    getVariant: tool({
      description:
        'Получить полный HTML-код ранее созданного варианта по его номеру. ' +
        'Используй, когда нужно доработать или сравнить старый вариант, код которого ' +
        'уже не виден в истории.',
      inputSchema: z.object({
        n: z.number().int().positive().describe('Номер варианта'),
      }),
      execute: async ({ n }) => {
        emit({ type: 'status', stage: 'fetching-variant', variant: n });
        const variant = getVariant(session, n);
        if (!variant) {
          const known = session.variants.map((v) => `#${v.n}`).join(', ');
          return {
            ok: false as const,
            error: `Варианта #${n} не существует. Доступны: ${known || 'пока ни одного'}.`,
          };
        }
        return {
          ok: true as const,
          n: variant.n,
          title: variant.title,
          html: variant.html,
        };
      },
      toModelOutput: ({ output }) =>
        output.ok
          ? {
              type: 'text',
              value: `Полный код варианта #${output.n} «${output.title}»:\n${output.html}`,
            }
          : { type: 'error-text', value: output.error },
    }),

    getAttachment: tool({
      description:
        'Посмотреть заново картинку, которую присылал пользователь, по её id. ' +
        'Нужен, когда картинка из старого сообщения уже вытеснена из контекста.',
      inputSchema: z.object({
        id: z.string().describe('Идентификатор картинки, например att_1_a3f9c2'),
      }),
      execute: async ({ id }) => {
        emit({ type: 'status', stage: 'fetching-attachment' });
        const found = getAttachment(session, id);
        if (!found) {
          const known = session.attachments.map((a) => a.id).join(', ');
          return {
            ok: false as const,
            error: `Картинки с id ${id} нет. Доступны: ${known || 'ни одной'}.`,
          };
        }
        return {
          ok: true as const,
          name: found.name,
          mediaType: found.mediaType,
          base64: found.data.toString('base64'),
        };
      },
      /**
       * Результат инструмента может нести файл, а не только текст — этим и
       * возвращаем картинку обратно в контекст модели. Часть `media` в v7
       * удалена, инлайновые данные едут частью `file` с тегированным data.
       */
      toModelOutput: ({ output }) =>
        output.ok
          ? {
              type: 'content',
              value: [
                { type: 'text', text: `Изображение «${output.name}»:` },
                {
                  type: 'file',
                  mediaType: output.mediaType,
                  data: { type: 'data', data: output.base64 },
                },
              ],
            }
          : { type: 'error-text', value: output.error },
    }),

    finishDialog: tool({
      description:
        'Завершить диалог. Вызывай ТОЛЬКО когда пользователь явно одобрил виджет ' +
        '(нажал «Принять» или написал «подходит», «принимаю», «одобряю»).',
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Кратко: какой вариант одобрен и чем закончили'),
      }),
      execute: async ({ reason }) => ({ ok: true as const, reason }),
      toModelOutput: () => ({
        type: 'text',
        value: 'Диалог помечен как завершённый.',
      }),
    }),
  };
}
