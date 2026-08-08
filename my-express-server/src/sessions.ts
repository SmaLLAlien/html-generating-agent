import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { DEFAULT_MODEL_ID } from './models.js';

export interface UserInfo {
  /** LDAP-логин пользователя */
  ldap: string;
  /** ФИО пользователя */
  fullName: string;
}

/**
 * Вариант виджета. Хранится вечно (в пределах жизни сессии) и адресуется по номеру.
 * Это отдельное от `messages` хранилище: вытеснение убирает код из поля зрения
 * модели, но не из реестра — превью и «Копировать» на клиенте работают всегда.
 */
export interface WidgetVariant {
  /** Монотонный номер в пределах сессии, начиная с 1 */
  n: number;
  /** Полный HTML-код варианта */
  html: string;
  /** Короткое название, 3–5 слов: для каталога в контексте и бейджа в UI */
  title: string;
  /** Номер варианта, который дорабатывался (варианты образуют дерево, не линию) */
  basedOn: number | null;
  accepted: boolean;
  /**
   * id вызова emitWidget, породившего вариант. По нему вытеснение находит
   * нужный tool-call в истории, не разбирая текст сообщений.
   */
  toolCallId: string | null;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  user: UserInfo;
  /** История диалога (память агента) */
  messages: ModelMessage[];
  /** Реестр всех созданных вариантов виджета */
  variants: WidgetVariant[];
  /** Счётчик номеров вариантов — не переиспользуется даже после отката */
  variantCounter: number;
  /** id выбранной модели из реестра models.ts */
  modelId: string;
  /** Размер контекста после последнего хода (input + output прошлого вызова) */
  contextTokens: number;
  /** Сколько ходов сделано в диалоге — агент видит это число и реже ходит по кругу */
  turnCount: number;
  createdAt: number;
  lastActivityAt: number;
}

/** Время жизни неактивной сессии — 1 час молчания пользователя */
const SESSION_TTL_MS = 60 * 60 * 1000;
/** Уборщик ходит часто, иначе «час молчания» на практике растягивается */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const sessions = new Map<string, ChatSession>();

export function createSession(user: UserInfo): ChatSession {
  const now = Date.now();
  const session: ChatSession = {
    id: randomUUID(),
    user,
    messages: [],
    variants: [],
    variantCounter: 0,
    modelId: DEFAULT_MODEL_ID,
    contextTokens: 0,
    turnCount: 0,
    createdAt: now,
    lastActivityAt: now,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): ChatSession | undefined {
  const session = sessions.get(id);
  if (session) {
    session.lastActivityAt = Date.now();
  }
  return session;
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id);
}

/** Зарегистрировать новый вариант и выдать ему номер. Номер присваивает сервер. */
export function addVariant(
  session: ChatSession,
  data: {
    html: string;
    title: string;
    basedOn: number | null;
    toolCallId?: string;
  }
): WidgetVariant {
  const variant: WidgetVariant = {
    n: ++session.variantCounter,
    html: data.html,
    title: data.title,
    basedOn: data.basedOn,
    accepted: false,
    toolCallId: data.toolCallId ?? null,
    createdAt: Date.now(),
  };
  session.variants.push(variant);
  return variant;
}

export function getVariant(
  session: ChatSession,
  n: number
): WidgetVariant | undefined {
  return session.variants.find((v) => v.n === n);
}

/** Последний созданный вариант — он всегда остаётся в контексте с полным кодом */
export function latestVariant(session: ChatSession): WidgetVariant | undefined {
  return session.variants.at(-1);
}

export function markAccepted(session: ChatSession, n: number): boolean {
  const variant = getVariant(session, n);
  if (!variant) return false;
  variant.accepted = true;
  return true;
}

/** Периодическая чистка протухших сессий */
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivityAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();
