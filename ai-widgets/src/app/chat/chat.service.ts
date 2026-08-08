import { Injectable } from '@angular/core';
import { ChatStreamEvent, ModelsResponse } from './chat.models';

export interface SendBody {
  text?: string;
  action?: 'accept' | 'revisit';
  variant?: number;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly base = '/api/chat';

  /** Список моделей и настройки бюджета контекста */
  async listModels(): Promise<ModelsResponse> {
    const resp = await fetch(`${this.base}/models`);
    if (!resp.ok) {
      throw new Error(`Не удалось получить список моделей (HTTP ${resp.status})`);
    }
    return (await resp.json()) as ModelsResponse;
  }

  /** Создать сессию, передав данные пользователя (LDAP + ФИО) */
  async createSession(
    ldap: string,
    fullName: string
  ): Promise<{ sessionId: string; modelId: string }> {
    const resp = await fetch(`${this.base}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ldap, fullName }),
    });
    if (!resp.ok) {
      throw new Error(`Не удалось создать сессию (HTTP ${resp.status})`);
    }
    return (await resp.json()) as { sessionId: string; modelId: string };
  }

  /** Сменить модель. История и варианты сессии сохраняются. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    const resp = await fetch(`${this.base}/${sessionId}/model`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId }),
    });
    if (!resp.ok) {
      throw new Error(`Не удалось сменить модель (HTTP ${resp.status})`);
    }
  }

  /** Завершить диалог: сервер удалит историю и все варианты сессии */
  async endSession(sessionId: string): Promise<void> {
    await fetch(`${this.base}/${sessionId}`, { method: 'DELETE' });
  }

  /**
   * То же при закрытии вкладки. `keepalive` (в отличие от sendBeacon) умеет DELETE
   * и переживает выгрузку страницы — иначе сессия висела бы до истечения TTL.
   */
  closeOnUnload(sessionId: string): void {
    try {
      fetch(`${this.base}/${sessionId}`, { method: 'DELETE', keepalive: true });
    } catch {
      /* вкладка уже выгружается — сессию доберёт уборщик по TTL */
    }
  }

  /** Отправить сообщение и читать SSE-поток ответа */
  async streamMessage(
    sessionId: string,
    body: SendBody,
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
