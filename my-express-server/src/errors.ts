import { APICallError, RetryError } from 'ai';
import type { ErrorCode } from './events.js';

export interface ClassifiedError {
  code: ErrorCode;
  /** Что показать пользователю. Внутренние детали сюда не попадают */
  message: string;
  retryable: boolean;
  /** Что записать в лог — здесь можно подробно */
  logDetail: string;
}

/** Прерывание по закрытию вкладки или кнопке «Стоп» — это не ошибка */
export function isAbort(err: unknown): boolean {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return true;
  }
  return RetryError.isInstance(err) && err.reason === 'abort';
}

/** Разворачиваем RetryError, чтобы добраться до настоящей причины */
function unwrap(err: unknown): unknown {
  if (RetryError.isInstance(err) && err.errors.length) {
    return err.errors[err.errors.length - 1];
  }
  return err;
}

/**
 * Раскладывает ошибку на понятную пользователю и подробную для лога.
 *
 * Раньше всё сваливалось в одну строку «Не удалось получить ответ от модели»,
 * из-за чего 429, неверный ключ и снятая с обслуживания модель выглядели
 * одинаково. Плюс сообщение про незаданный GEMINI_API_KEY уезжало в браузер
 * вместе с путём к файлу на сервере.
 */
export function classifyError(err: unknown): ClassifiedError {
  const raw = unwrap(err);
  const detail =
    raw instanceof Error ? `${raw.name}: ${raw.message}` : String(raw);

  // Ключ не задан — конфигурация сервера. Пользователю про путь к .env знать незачем
  if (raw instanceof Error && raw.message.includes('GEMINI_API_KEY')) {
    return {
      code: 'auth',
      message:
        'Сервис не настроен: администратору нужно задать ключ доступа к модели.',
      retryable: false,
      logDetail: detail,
    };
  }

  if (APICallError.isInstance(raw)) {
    const status = raw.statusCode;

    if (status === 429) {
      return {
        code: 'rate-limit',
        message:
          'Модель перегружена запросами. Подождите несколько секунд и попробуйте снова.',
        retryable: true,
        logDetail: `${detail} (status ${status})`,
      };
    }
    if (status === 401 || status === 403) {
      return {
        code: 'auth',
        message: 'Ключ доступа к модели отклонён. Обратитесь к администратору.',
        retryable: false,
        logDetail: `${detail} (status ${status})`,
      };
    }
    if (status === 404) {
      return {
        code: 'model',
        message:
          'Выбранная модель недоступна. Попробуйте переключиться на другую в шапке чата.',
        retryable: false,
        logDetail: `${detail} (status ${status})`,
      };
    }
    if (status != null && status >= 500) {
      return {
        code: 'network',
        message: 'Модель временно недоступна. Попробуйте повторить.',
        retryable: true,
        logDetail: `${detail} (status ${status})`,
      };
    }
    return {
      code: 'unknown',
      message: 'Модель отклонила запрос. Попробуйте переформулировать.',
      retryable: false,
      logDetail: `${detail} (status ${status ?? '—'})`,
    };
  }

  // Сетевой сбой до провайдера: fetch бросает TypeError
  if (raw instanceof TypeError) {
    return {
      code: 'network',
      message: 'Нет связи с моделью. Проверьте сеть и попробуйте повторить.',
      retryable: true,
      logDetail: detail,
    };
  }

  return {
    code: 'unknown',
    message: 'Не удалось получить ответ от модели. Попробуйте ещё раз.',
    retryable: true,
    logDetail: detail,
  };
}
