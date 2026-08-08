/** Итоговый структурированный ответ агента */
export interface AgentFinal {
  message: string;
  /** Полный HTML-код виджета (без JS) — отдельным полем, чтобы его можно было забрать как есть */
  widgetHtml: string | null;
  /** true — пользователь одобрил виджет, чат можно закрывать */
  canClose: boolean;
}

/** События SSE-потока от сервера */
export type ChatStreamEvent =
  | { type: 'partial'; message: string }
  | ({ type: 'final' } & AgentFinal)
  | { type: 'error'; error: string };

/** Сообщение в ленте чата */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  widgetHtml?: string | null;
  /** Виджет из этого сообщения принят кнопкой «Принять» */
  accepted?: boolean;
  /** Ответ ещё стримится */
  streaming?: boolean;
  error?: boolean;
  /** Показать блок с кодом */
  showCode?: boolean;
  /** Время отправки (ЧЧ:ММ) */
  time?: string;
}
