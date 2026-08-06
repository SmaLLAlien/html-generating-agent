import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';

export interface UserInfo {
  /** LDAP-логин пользователя */
  ldap: string;
  /** ФИО пользователя */
  fullName: string;
}

export interface ChatSession {
  id: string;
  user: UserInfo;
  /** История диалога (память агента) */
  messages: ModelMessage[];
  createdAt: number;
  lastActivityAt: number;
}

/** Время жизни неактивной сессии — 2 часа */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

const sessions = new Map<string, ChatSession>();

export function createSession(user: UserInfo): ChatSession {
  const now = Date.now();
  const session: ChatSession = {
    id: randomUUID(),
    user,
    messages: [],
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
