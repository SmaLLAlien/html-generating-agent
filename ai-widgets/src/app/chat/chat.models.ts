/** Причина ошибки — зеркало ErrorCode на сервере */
export type ErrorCode =
  | 'rate-limit'
  | 'safety'
  | 'auth'
  | 'model'
  | 'network'
  | 'tool'
  | 'busy'
  | 'unknown';

/** События SSE-потока (зеркало AgentEvent на сервере) */
export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | {
      type: 'widget';
      variant: number;
      title: string;
      basedOn: number | null;
      html: string;
    }
  | {
      type: 'status';
      stage: 'widget-start' | 'fetching-variant' | 'fetching-attachment';
      variant?: number;
    }
  | {
      type: 'usage';
      contextTokens: number;
      budget: number;
      percent: number;
      cachedTokens?: number;
      reasoningTokens?: number;
    }
  | { type: 'limit'; contextTokens: number; budget: number }
  | { type: 'done'; finished: boolean; truncated?: boolean }
  | { type: 'error'; error: string; code: ErrorCode; retryable: boolean };

export interface ModelInfo {
  id: string;
  label: string;
  /** Физическое окно модели, токенов */
  contextWindow: number;
  hint: string;
}

export interface ModelsResponse {
  models: ModelInfo[];
  defaultModelId: string;
  contextBudget: number;
  warnRatio: number;
}

/** Расход контекста по данным последнего ответа модели */
export interface ContextInfo {
  contextTokens: number;
  budget: number;
  percent: number;
  /** Сколько входных токенов пришло из неявного кеша Gemini */
  cachedTokens?: number;
  /** Токены на размышления модели — заметны у семейства Gemini 3 */
  reasoningTokens?: number;
}

/** Картинка, приложенная пользователем: и для отправки, и для показа в ленте */
export interface ChatAttachment {
  /** id из реестра сессии на сервере */
  id: string;
  name: string;
  /** data URL — тот же, что ушёл на сервер; используется как src превью */
  dataUrl: string;
  sizeBytes: number;
}

/** Что нужно, чтобы повторить упавший ход, ничего не переспрашивая */
export interface FailedTurn {
  body: {
    text?: string;
    action?: 'accept' | 'revisit';
    variant?: number;
    attachmentIds?: string[];
  };
  shownText: string;
  attachments?: ChatAttachment[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Картинки, которые пользователь приложил к этому сообщению */
  attachments?: ChatAttachment[];
  widgetHtml?: string | null;
  /** Номер варианта, присвоенный сервером */
  variant?: number;
  variantTitle?: string;
  /** Номер варианта, который дорабатывался */
  basedOn?: number | null;
  /** «Принять» нажато для виджета этого сообщения */
  accepted?: boolean;
  /** Превью развёрнуто на всю высоту */
  expanded?: boolean;
  streaming?: boolean;
  /** Модель собирает виджет — показываем индикацию */
  buildingWidget?: boolean;
  error?: boolean;
  /** Ход прерван пользователем — это не ошибка, но повторить тоже надо дать */
  stopped?: boolean;
  /** Ход можно повторить — показываем кнопку */
  retryable?: boolean;
  /** Ответ обрезан по лимиту токенов */
  truncated?: boolean;
  /** Блок кода развёрнут */
  showCode?: boolean;
  /** Служебная плашка в ленте (предупреждение о контексте, лимит, истёкшая сессия) */
  notice?: 'warn' | 'limit' | 'expired';
  /** Процент на момент появления плашки — иначе она «переписывается» задним числом */
  noticePercent?: number;
  time?: string;
}
