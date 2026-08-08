/**
 * События, которые сервер отдаёт клиенту по SSE.
 *
 * Контракт v2: текст едет приращениями (`text`), а виджет — отдельным событием,
 * потому что он больше не поле JSON-ответа, а результат вызова инструмента.
 */
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
  /** Ход завершён. finished = агент вызвал finishDialog */
  | { type: 'done'; finished: boolean }
  | { type: 'error'; error: string };

export type EmitEvent = (event: AgentEvent) => void;
