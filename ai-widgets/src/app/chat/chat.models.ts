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
      stage: 'widget-start' | 'fetching-variant';
      variant?: number;
    }
  | {
      type: 'usage';
      contextTokens: number;
      budget: number;
      percent: number;
      cachedTokens?: number;
    }
  | { type: 'limit'; contextTokens: number; budget: number }
  | { type: 'done'; finished: boolean }
  | { type: 'error'; error: string };

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
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  widgetHtml?: string | null;
  /** Номер варианта, присвоенный сервером */
  variant?: number;
  variantTitle?: string;
  /** Номер варианта, который дорабатывался */
  basedOn?: number | null;
  /** «Принять» нажато для виджета этого сообщения */
  accepted?: boolean;
  streaming?: boolean;
  /** Модель собирает виджет — показываем индикацию */
  buildingWidget?: boolean;
  error?: boolean;
  /** Блок кода развёрнут */
  showCode?: boolean;
  /** Служебная плашка в ленте (предупреждение о контексте, лимит) */
  notice?: 'warn' | 'limit';
  /** Процент на момент появления плашки — иначе она «переписывается» задним числом */
  noticePercent?: number;
  time?: string;
}
