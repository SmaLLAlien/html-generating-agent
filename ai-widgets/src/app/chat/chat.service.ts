import { Injectable } from '@angular/core';
import { ChatStreamEvent, ModelsResponse } from './chat.models';

export interface SendBody {
  text?: string;
  action?: 'accept' | 'revisit';
  variant?: number;
}

/** Ошибка с распознанной причиной — клиент решает, предлагать ли «Повторить» */
export class ChatHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'ChatHttpError';
  }
}

/** Сколько ждём ответ, прежде чем считать соединение зависшим */
const REQUEST_TIMEOUT_MS = 20_000;
/** Ход агента бывает долгим, но не бесконечным */
const STREAM_TIMEOUT_MS = 180_000;

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly base = '/api/chat';

  /**
   * fetch с таймаутом и внешним сигналом отмены.
   * Без таймаута зависший без закрытия TCP сервер вешал весь интерфейс:
   * промис не резолвился и не реджектился никогда.
   */
  private async request(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    external?: AbortSignal
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onExternalAbort = () => ctrl.abort();
    external?.addEventListener('abort', onExternalAbort);

    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Список моделей и настройки бюджета контекста */
  async listModels(): Promise<ModelsResponse> {
    const resp = await this.request(`${this.base}/models`, {}, REQUEST_TIMEOUT_MS);
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
    const resp = await this.request(
      `${this.base}/session`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ldap, fullName }),
      },
      REQUEST_TIMEOUT_MS
    );
    if (!resp.ok) {
      throw new Error(`Не удалось создать сессию (HTTP ${resp.status})`);
    }
    return (await resp.json()) as { sessionId: string; modelId: string };
  }

  /** Сменить модель. История и варианты сессии сохраняются. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    const resp = await this.request(
      `${this.base}/${sessionId}/model`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      },
      REQUEST_TIMEOUT_MS
    );
    if (!resp.ok) {
      throw new ChatHttpError(
        `Не удалось сменить модель (HTTP ${resp.status})`,
        resp.status,
        false
      );
    }
  }

  /** Завершить диалог: сервер удалит историю и все варианты сессии */
  async endSession(sessionId: string): Promise<void> {
    await this.request(
      `${this.base}/${sessionId}`,
      { method: 'DELETE' },
      REQUEST_TIMEOUT_MS
    ).catch(() => undefined);
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
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const resp = await this.request(
      `${this.base}/${sessionId}/message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      STREAM_TIMEOUT_MS,
      signal
    );

    if (!resp.ok || !resp.body) {
      let message = `Ошибка сервера (HTTP ${resp.status})`;
      try {
        const data = (await resp.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        /* тело не JSON — оставляем общий текст */
      }
      // 404 — сессия истекла, повтор не поможет; 409 — уже идёт ход
      throw new ChatHttpError(message, resp.status, resp.status >= 500);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    /**
     * Разбор кадров. Обработчик вынесен ИЗ try: раньше он был внутри, и любое
     * исключение в компоненте выглядело как битый кадр и исчезало бесследно.
     */
    const drain = (flush: boolean) => {
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        emitChunk(chunk);
      }
      // Сервер может завершить поток, не дослав финальный разделитель —
      // тогда последнее событие (обычно done) просто терялось
      if (flush && buffer.trim()) {
        emitChunk(buffer);
        buffer = '';
      }
    };

    const emitChunk = (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        // По спецификации пробел после двоеточия необязателен
        const payload = line.slice(5).trimStart();
        if (!payload) continue;
        let event: ChatStreamEvent;
        try {
          event = JSON.parse(payload) as ChatStreamEvent;
        } catch {
          continue; // битый кадр пропускаем, но ошибки обработчика не глотаем
        }
        onEvent(event);
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain(false);
    }
    buffer += decoder.decode();
    drain(true);
  }
}
