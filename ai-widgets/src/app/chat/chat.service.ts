import { Injectable } from '@angular/core';
import { ChatStreamEvent } from './chat.models';

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly base = '/api/chat';

  /** Создать сессию, передав данные пользователя (LDAP + ФИО) */
  async createSession(ldap: string, fullName: string): Promise<string> {
    const resp = await fetch(`${this.base}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ldap, fullName }),
    });
    if (!resp.ok) {
      throw new Error(`Не удалось создать сессию (HTTP ${resp.status})`);
    }
    const data = (await resp.json()) as { sessionId: string };
    return data.sessionId;
  }

  /** Завершить диалог: сервер удалит память сессии */
  async endSession(sessionId: string): Promise<void> {
    await fetch(`${this.base}/${sessionId}`, { method: 'DELETE' });
  }

  /**
   * Отправить сообщение и читать SSE-поток ответа.
   * body: { text } — обычное сообщение, { action: 'accept' } — нажата кнопка «Принять».
   */
  async streamMessage(
    sessionId: string,
    body: { text?: string; action?: 'accept' },
    onEvent: (event: ChatStreamEvent) => void
  ): Promise<void> {
    const resp = await fetch(`${this.base}/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok || !resp.body) {
      let message = `Ошибка сервера (HTTP ${resp.status})`;
      try {
        const data = (await resp.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        /* тело не JSON — оставляем общий текст */
      }
      throw new Error(message);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              onEvent(JSON.parse(line.slice(6)) as ChatStreamEvent);
            } catch {
              /* пропускаем битое событие */
            }
          }
        }
      }
    }
  }
}
