/**
 * События, которые сервер отдаёт клиенту по SSE.
 *
 * Контракт v2: текст едет приращениями (`text`), а виджет — отдельным событием,
 * потому что он больше не поле JSON-ответа, а результат вызова инструмента.
 */

/**
 * Причина ошибки. Клиент по ней решает, показывать ли кнопку «Повторить»
 * и что советовать пользователю: раньше все сбои выглядели одинаково.
 */
export type ErrorCode =
  | 'rate-limit' // 429 от провайдера, помогает подождать
  | 'safety' // модель отказалась по правилам безопасности
  | 'auth' // ключ не задан или не принят
  | 'model' // модель недоступна или снята с обслуживания
  | 'network' // сеть или таймаут провайдера
  | 'tool' // упал инструмент агента
  | 'busy' // в этой сессии уже идёт ход
  | 'unknown';

export type AgentEvent =
  /** Приращение текста ответа (не весь текст целиком) */
  | { type: 'text'; delta: string }
  /** Модель выдала новую версию виджета */
  | {
      type: 'widget';
      variant: number;
      title: string;
      basedOn: number | null;
      html: string;
    }
  /** Индикация долгой операции, чтобы пауза не выглядела зависанием */
  | {
      type: 'status';
      stage: 'widget-start' | 'fetching-variant';
      variant?: number;
    }
  /** Расход контекста после хода */
  | {
      type: 'usage';
      contextTokens: number;
      budget: number;
      percent: number;
      /** Сколько входных токенов пришло из неявного кеша Gemini */
      cachedTokens?: number;
      /** Токены на размышления модели. Оплачиваются, но в историю не попадают */
      reasoningTokens?: number;
    }
  /** Бюджет контекста исчерпан — диалог дальше не продолжаем */
  | { type: 'limit'; contextTokens: number; budget: number }
  /**
   * Ход завершён.
   * `finished` — агент вызвал finishDialog.
   * `truncated` — ответ обрезан по лимиту токенов, а не закончен моделью.
   */
  | { type: 'done'; finished: boolean; truncated?: boolean }
  /** Ошибка. `retryable` — есть ли смысл предлагать «Повторить» */
  | { type: 'error'; error: string; code: ErrorCode; retryable: boolean };

export type EmitEvent = (event: AgentEvent) => void;
