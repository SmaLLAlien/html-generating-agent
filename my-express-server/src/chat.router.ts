import { Router, type Request, type Response } from 'express';
import { runAgent } from './agent.js';
import { createSession, deleteSession, getSession } from './sessions.js';

export const chatRouter = Router();

/** Создать чат-сессию. Тело: { ldap, fullName } */
chatRouter.post('/session', (req: Request, res: Response) => {
  const { ldap, fullName } = (req.body ?? {}) as {
    ldap?: unknown;
    fullName?: unknown;
  };

  if (
    typeof ldap !== 'string' ||
    !ldap.trim() ||
    typeof fullName !== 'string' ||
    !fullName.trim()
  ) {
    res.status(400).json({ error: 'Поля ldap и fullName обязательны' });
    return;
  }

  const session = createSession({
    ldap: ldap.trim(),
    fullName: fullName.trim(),
  });
  res.status(201).json({ sessionId: session.id });
});

/**
 * Отправить сообщение агенту. Тело: { text } или { action: 'accept' }.
 * Ответ — SSE-поток событий:
 *   { type: 'partial', message }                      — текст по мере генерации
 *   { type: 'final', message, widgetHtml, canClose }  — итоговый структурированный ответ
 *   { type: 'error', error }                          — ошибка
 */
chatRouter.post(
  '/:sessionId/message',
  async (req: Request, res: Response) => {
    const session = getSession(req.params.sessionId as string);
    if (!session) {
      res.status(404).json({ error: 'Сессия не найдена или истекла' });
      return;
    }

    const { text, action } = (req.body ?? {}) as {
      text?: unknown;
      action?: unknown;
    };

    let userText: string;
    if (action === 'accept') {
      userText =
        '[Системное событие] Пользователь нажал кнопку «Принять» под последним виджетом. Виджет одобрен.';
    } else if (typeof text === 'string' && text.trim()) {
      userText = text.trim();
    } else {
      res.status(400).json({ error: 'Нужно поле text либо action: "accept"' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const final = await runAgent(session, userText, (partial) =>
        send({ type: 'partial', message: partial.message })
      );
      send({ type: 'final', ...final });
    } catch (err) {
      console.error('Ошибка агента:', err);
      send({
        type: 'error',
        error:
          err instanceof Error && err.message.includes('GEMINI_API_KEY')
            ? err.message
            : 'Не удалось получить ответ от модели. Попробуйте ещё раз.',
      });
    } finally {
      res.end();
    }
  }
);

/** Завершить диалог и удалить память сессии */
chatRouter.delete('/:sessionId', (req: Request, res: Response) => {
  deleteSession(req.params.sessionId as string);
  res.status(204).end();
});
