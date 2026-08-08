import { Router, type Request, type Response } from 'express';
import { recordFailedTurn, runAgent } from './agent.js';
import {
  CONTEXT_BUDGET_TOKENS,
  CONTEXT_WARN_RATIO,
  MAX_MESSAGE_LENGTH,
} from './config.js';
import { classifyError, isAbort } from './errors.js';
import type { AgentEvent } from './events.js';
import { logError, logInfo, logWarn } from './log.js';
import { DEFAULT_MODEL_ID, MODELS, isKnownModel } from './models.js';
import {
  createSession,
  deleteSession,
  getSession,
  getVariant,
  markAccepted,
  sessionCount,
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

  // Данные попадают в системный промпт, поэтому длину ограничиваем
  const session = createSession({
    ldap: ldap.trim().slice(0, 120),
    fullName: fullName.trim().slice(0, 200),
  });
  logInfo('session.created', { sessionId: session.id, ldap: session.user.ldap }, {
    total: sessionCount(),
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

  const previous = session.modelId;
  session.modelId = modelId;
  logInfo('model.changed', { sessionId: session.id, ldap: session.user.ldap }, {
    from: previous,
    to: modelId,
  });
  res.json({ modelId });
});

/**
 * Отправить сообщение агенту.
 * Тело: { text } | { action: 'accept', variant } | { action: 'revisit', variant, text }
 *
 * Ответ — SSE-поток событий (см. AgentEvent в events.ts):
 *   text / widget / status / usage / limit / done / error
 */
chatRouter.post('/:sessionId/message', async (req: Request, res: Response) => {
  const session = getSession(req.params.sessionId as string);
  if (!session) {
    res.status(404).json({ error: 'Сессия не найдена или истекла' });
    return;
  }

  const ctx = { sessionId: session.id, ldap: session.user.ldap };

  const { text, action, variant } = (req.body ?? {}) as {
    text?: unknown;
    action?: unknown;
    variant?: unknown;
  };

  const variantNumber =
    typeof variant === 'number' && Number.isInteger(variant) && variant > 0
      ? variant
      : null;
  const userComment =
    typeof text === 'string' ? text.trim().slice(0, MAX_MESSAGE_LENGTH) : '';

  // Приняли вариант — но пометку ставим только если он существует,
  // иначе агенту уходило сообщение про несуществующий номер
  let acceptedVariant: number | null = null;
  let userText: string;

  if (action === 'accept') {
    acceptedVariant =
      variantNumber != null && getVariant(session, variantNumber)
        ? variantNumber
        : null;
    userText =
      '[Системное событие] Пользователь нажал кнопку «Принять»' +
      (acceptedVariant != null ? ` под вариантом #${acceptedVariant}` : '') +
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

  // Два параллельных хода в одной сессии перемешали бы историю и разъехались
  // бы на счётчиках вариантов и токенов
  if (session.busy) {
    res.status(409).json({ error: 'В этом диалоге уже идёт ответ' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // nginx по умолчанию буферизует proxy_pass и съедает стриминг
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event: AgentEvent) => {
    if (res.writableEnded || res.destroyed) return;
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

  const abort = new AbortController();
  // Клиент закрыл вкладку или нажал «Стоп» — прекращаем генерацию.
  // Без этого модель дописывала ответ в никуда, а токены списывались.
  const onClose = () => abort.abort();
  res.on('close', onClose);

  // Какие варианты создал этот ход — нужно на случай обрыва
  const variantsBefore = session.variants.length;

  session.busy = true;
  try {
    const { finished, truncated } = await runAgent(
      session,
      userText,
      send,
      abort.signal
    );
    if (acceptedVariant != null) markAccepted(session, acceptedVariant);
    send({ type: 'done', finished, truncated });
  } catch (err) {
    const created = session.variants.slice(variantsBefore).map((v) => v.n);
    recordFailedTurn(session, userText, created);

    if (isAbort(err)) {
      logWarn('turn.aborted', ctx, { created: created.join(',') });
    } else {
      const info = classifyError(err);
      logError('turn.failed', ctx, {
        code: info.code,
        detail: info.logDetail,
        created: created.join(','),
      });
      send({
        type: 'error',
        error: info.message,
        code: info.code,
        retryable: info.retryable,
      });
      send({ type: 'done', finished: false });
    }
  } finally {
    session.busy = false;
    res.off('close', onClose);
    res.end();
  }
});

/** Завершить диалог и удалить память сессии */
chatRouter.delete('/:sessionId', (req: Request, res: Response) => {
  const id = req.params.sessionId as string;
  if (deleteSession(id)) {
    logInfo('session.deleted', { sessionId: id }, { total: sessionCount() });
  }
  res.status(204).end();
});
