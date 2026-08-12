import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import {
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_SESSIONS,
  MAX_VARIANTS_PER_SESSION,
} from './config.js';
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

/**
 * Картинка, приложенная пользователем.
 *
 * Хранится отдельно от истории по той же причине, что и код вариантов: в
 * контексте модели остаётся только последний набор, всё старше заменяется
 * стабом, а полные данные достаются инструментом getAttachment.
 */
export interface Attachment {
  id: string;
  kind: 'image';
  name: string;
  mediaType: string;
  data: Buffer;
  sizeBytes: number;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  user: UserInfo;
  /** История диалога (память агента) */
  messages: ModelMessage[];
  /** Реестр всех созданных вариантов виджета */
  variants: WidgetVariant[];
  /** Реестр приложенных картинок */
  attachments: Attachment[];
  /** Счётчик номеров вариантов — не переиспользуется даже после отката */
  variantCounter: number;
  /** id выбранной модели из реестра models.ts */
  modelId: string;
  /** Размер контекста после последнего хода (input + output прошлого вызова) */
  contextTokens: number;
  /** Сколько ходов сделано в диалоге — агент видит это число и реже ходит по кругу */
  turnCount: number;
  /**
   * В сессии сейчас идёт ход. Два параллельных запроса перемешали бы историю
   * и разъехались бы на счётчиках, поэтому второй отклоняем.
   */
  busy: boolean;
  createdAt: number;
  lastActivityAt: number;
}

/** Время жизни неактивной сессии — 1 час молчания пользователя */
const SESSION_TTL_MS = 60 * 60 * 1000;
/** Уборщик ходит часто, иначе «час молчания» на практике растягивается */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const sessions = new Map<string, ChatSession>();

/**
 * Вытесняем самую давно неактивную сессию. Создание сессии не требует
 * аутентификации, поэтому без потолка цикл запросов просто съедает память.
 */
function evictOldestSession(): void {
  let oldestId: string | null = null;
  let oldestAt = Infinity;
  for (const [id, s] of sessions) {
    if (s.lastActivityAt < oldestAt) {
      oldestAt = s.lastActivityAt;
      oldestId = id;
    }
  }
  if (oldestId) sessions.delete(oldestId);
}

export function createSession(user: UserInfo): ChatSession {
  if (sessions.size >= MAX_SESSIONS) evictOldestSession();

  const now = Date.now();
  const session: ChatSession = {
    id: randomUUID(),
    user,
    messages: [],
    variants: [],
    attachments: [],
    variantCounter: 0,
    modelId: DEFAULT_MODEL_ID,
    contextTokens: 0,
    turnCount: 0,
    busy: false,
    createdAt: now,
    lastActivityAt: now,
  };
  sessions.set(session.id, session);
  return session;
}

export function sessionCount(): number {
  return sessions.size;
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
/** Есть ли ещё место под вариант — проверяется до вызова addVariant */
export function canAddVariant(session: ChatSession): boolean {
  return session.variants.length < MAX_VARIANTS_PER_SESSION;
}

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

/** Есть ли ещё место под вложение */
export function canAddAttachment(session: ChatSession): boolean {
  return session.attachments.length < MAX_ATTACHMENTS_PER_SESSION;
}

export function addAttachment(
  session: ChatSession,
  data: { name: string; mediaType: string; data: Buffer; sizeBytes: number }
): Attachment {
  const attachment: Attachment = {
    id: `att_${session.attachments.length + 1}_${randomUUID().slice(0, 6)}`,
    kind: 'image',
    ...data,
    createdAt: Date.now(),
  };
  session.attachments.push(attachment);
  return attachment;
}

export function getAttachment(
  session: ChatSession,
  id: string
): Attachment | undefined {
  return session.attachments.find((a) => a.id === id);
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
