import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import { chatRouter } from './chat.router.js';
import { logError, logInfo, logWarn } from './log.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(express.json({ limit: '1mb' }));

app.get('/', (_req: Request, res: Response) => {
  res.send('TypeScript Express сервер працює!');
});

app.use('/api/chat', chatRouter);

/**
 * Ошибки до попадания в обработчик — слишком большое тело, битый JSON.
 * Без этого Express отдавал HTML-страницу, и клиент, ожидающий JSON,
 * падал на разборе ответа вместо того, чтобы показать причину.
 */
app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = (err as { status?: number }).status ?? 500;
  const message =
    status === 413
      ? 'Слишком большой запрос'
      : status === 400
        ? 'Некорректный запрос'
        : 'Внутренняя ошибка сервера';
  logError('request.failed', {}, { status, detail: err.message });
  res.status(status).json({ error: message });
});

const server = app.listen(PORT, () => {
  logInfo('server.started', {}, { port: PORT });
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    logWarn('server.noApiKey', {}, {
      hint: 'создайте my-express-server/.env по образцу .env.example',
    });
  }
});

server.on('error', (err) => {
  logError('server.listenFailed', {}, { detail: err.message, port: PORT });
  process.exit(1);
});

// Без этих обработчиков любое необработанное отклонение промиса роняет
// процесс молча: в логах не остаётся ни причины, ни контекста.
process.on('unhandledRejection', (reason) => {
  logError('process.unhandledRejection', {}, {
    detail: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
  });
});

process.on('uncaughtException', (err) => {
  logError('process.uncaughtException', {}, { detail: err.stack ?? err.message });
  // Состояние процесса после этого недоверенное — выходим, пусть перезапустят
  shutdown('uncaughtException', 1);
});

let shuttingDown = false;

/** Даём доиграть открытым SSE-потокам, но не бесконечно */
function shutdown(reason: string, code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo('server.shutdown', {}, { reason });

  const force = setTimeout(() => {
    logWarn('server.forcedExit', {}, { reason });
    process.exit(code);
  }, 10_000);
  force.unref();

  server.close(() => {
    clearTimeout(force);
    process.exit(code);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
