import { Router, type Request, type Response } from 'express';
import { runAgent } from './agent.js';
import { CONTEXT_BUDGET_TOKENS, CONTEXT_WARN_RATIO } from './config.js';
import type { AgentEvent } from './events.js';
import { DEFAULT_MODEL_ID, MODELS, isKnownModel } from './models.js';
import {
  createSession,
  deleteSession,
  getSession,
  getVariant,
  markAccepted,
} from './sessions.js';

export const chatRouter = Router();

/** Список доступных моделей и настройки контекста */
chatRouter.get('/models', (_req: Request, res: Response) => {
  res.json({
    models: MODELS,
    defaultModelId: DEFAULT_MODEL_ID,
    contextBudget: CONTEXT_BUDGET_TOKENS,
    warnRatio: CONTEXT_WARN_RATIO,
  });
});

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
  res.status(201).json({ sessionId: session.id, modelId: session.modelId });
});

/** Сменить модель на лету. История и варианты сохраняются. */
chatRouter.patch('/:sessionId/model', (req: Request, res: Response) => {
  const session = getSession(req.params.sessionId as string);
  if (!session) {
    res.status(404).json({ error: 'Сессия не найдена или истекла' });
    return;
  }

  const { modelId } = (req.body ?? {}) as { modelId?: unknown };
  if (!isKnownModel(modelId)) {
    res.status(400).json({ error: 'Неизвестная модель' });
    return;
  }

  session.modelId = modelId;
  res.json({ modelId });
});

/**
 * Отправить сообщение агенту.
 * Тело: { text } | { action: 'accept', variant } | { action: 'revisit', variant, text }
 *
 * Ответ — SSE-поток событий (см. AgentEvent в events.ts):
 *   text / widget / status / usage / done / error
 */
chatRouter.post('/:sessionId/message', async (req: Request, res: Response) => {
  const session = getSession(req.params.sessionId as string);
  if (!session) {
    res.status(404).json({ error: 'Сессия не найдена или истекла' });
    return;
  }

  const { text, action, variant } = (req.body ?? {}) as {
    text?: unknown;
    action?: unknown;
    variant?: unknown;
  };

  const variantNumber = typeof variant === 'number' ? variant : null;
  const userComment = typeof text === 'string' ? text.trim() : '';

  let userText: string;
  if (action === 'accept') {
    if (variantNumber != null) markAccepted(session, variantNumber);
    userText =
      '[Системное событие] Пользователь нажал кнопку «Принять»' +
      (variantNumber != null ? ` под вариантом #${variantNumber}` : '') +
      '. Виджет одобрен.';
  } else if (action === 'revisit') {
    if (variantNumber == null || !getVariant(session, variantNumber)) {
      res.status(400).json({ error: 'Указан несуществующий вариант' });
      return;
    }
    userText =
      `[Системное событие] Пользователь выбрал вариант #${variantNumber} для доработки. ` +
      `Возьми его полный код инструментом getVariant(${variantNumber}) и работай от него.` +
      (userComment ? `\n\nЧто просит пользователь: ${userComment}` : '');
  } else if (userComment) {
    userText = userComment;
  } else {
    res.status(400).json({ error: 'Нужно поле text либо action' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Страж бюджета. Клиент тоже блокирует ввод, но полагаться только на него нельзя.
  if (session.contextTokens >= CONTEXT_BUDGET_TOKENS) {
    send({
      type: 'limit',
      contextTokens: session.contextTokens,
      budget: CONTEXT_BUDGET_TOKENS,
    });
    send({ type: 'done', finished: false });
    res.end();
    return;
  }

  try {
    const { finished } = await runAgent(session, userText, send);
    send({ type: 'done', finished });
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
});

/** Завершить диалог и удалить память сессии */
chatRouter.delete('/:sessionId', (req: Request, res: Response) => {
  deleteSession(req.params.sessionId as string);
  res.status(204).end();
});
