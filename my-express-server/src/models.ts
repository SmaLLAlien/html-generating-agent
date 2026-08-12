import {
  createGoogleGenerativeAI,
  type GoogleGenerativeAIProvider,
} from '@ai-sdk/google';

/** Уровни мышления Gemini 3. Это относительные допуски, а не бюджет в токенах. */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface ModelInfo {
  id: string;
  label: string;
  /** Размер контекстного окна модели, токенов */
  contextWindow: number;
  hint: string;
  /**
   * Поколение. Определяет, как передавать настройки мышления и temperature:
   * у семейства 3 своя ручка thinkingLevel, и Google просит не задавать
   * temperature явно — иначе модель склонна зацикливаться.
   */
  family: 'gemini-2.5' | 'gemini-3';
  /** Только для семейства 3. thinkingLevel и thinkingBudget несовместимы. */
  thinkingLevel?: ThinkingLevel;
}

/**
 * Доступные модели. Список выверен запросами к API: `gemini-3-pro-preview`
 * снят с обслуживания, поэтому его здесь нет.
 *
 * Уровни мышления подобраны под задачу: вёрстка HTML не требует глубоких
 * рассуждений, а reasoning-токены оплачиваются как выходные. На тривиальном
 * запросе модели семейства 3 тратят 250–500 токенов только на размышления,
 * поэтому уровень по умолчанию ниже, чем у Google.
 */
export const MODELS: readonly ModelInfo[] = [
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    contextWindow: 1_048_576,
    hint: 'Проверенный баланс скорости и качества',
    family: 'gemini-2.5',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    contextWindow: 1_048_576,
    hint: 'Точнее с инструментами, но медленнее',
    family: 'gemini-2.5',
  },
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    contextWindow: 1_048_576,
    hint: 'Новое поколение: лучше следует инструментам',
    family: 'gemini-3',
    thinkingLevel: 'low',
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash Lite',
    contextWindow: 1_048_576,
    hint: 'Самая быстрая и дешёвая, мышление минимальное',
    family: 'gemini-3',
    thinkingLevel: 'minimal',
  },
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro (preview)',
    contextWindow: 1_048_576,
    hint: 'Самая сильная, глубокое мышление, дорогая и медленная',
    family: 'gemini-3',
    thinkingLevel: 'medium',
  },
] as const;

const FALLBACK_MODEL_ID = 'gemini-2.5-flash';

export function isKnownModel(id: unknown): id is string {
  return typeof id === 'string' && MODELS.some((m) => m.id === id);
}

/** Дефолт можно переопределить через GEMINI_MODEL, если такая модель есть в реестре */
export const DEFAULT_MODEL_ID: string = isKnownModel(process.env.GEMINI_MODEL)
  ? process.env.GEMINI_MODEL
  : FALLBACK_MODEL_ID;

export function getModelInfo(id: string): ModelInfo {
  return (
    MODELS.find((m) => m.id === id) ??
    MODELS.find((m) => m.id === FALLBACK_MODEL_ID)!
  );
}

/**
 * Настройки вызова, зависящие от поколения модели.
 *
 * Семейство 3:
 * - thinkingLevel вместо thinkingBudget (передать оба в одном запросе нельзя);
 * - temperature НЕ задаём. Google прямо просит этого не делать при переходе
 *   с 2.5: при явной temperature модель склонна зацикливаться и деградировать.
 *
 * Семейство 2.5 сохраняет прежнее поведение — temperature 0.7 и никаких
 * настроек мышления.
 */
export interface ModelCallSettings {
  temperature?: number;
  providerOptions?: {
    google: { thinkingConfig: { thinkingLevel: ThinkingLevel } };
  };
}

export function callSettingsFor(modelId: string): ModelCallSettings {
  const info = getModelInfo(modelId);

  if (info.family === 'gemini-3') {
    return info.thinkingLevel
      ? {
          providerOptions: {
            google: { thinkingConfig: { thinkingLevel: info.thinkingLevel } },
          },
        }
      : {};
  }

  return { temperature: 0.7 };
}

let provider: GoogleGenerativeAIProvider | null = null;

function getProvider(): GoogleGenerativeAIProvider {
  const apiKey =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Не задан GEMINI_API_KEY. Создайте файл my-express-server/.env по образцу .env.example.'
    );
  }
  if (!provider) {
    provider = createGoogleGenerativeAI({ apiKey });
  }
  return provider;
}

/**
 * Модель по id. Провайдер мемоизирован, сам объект модели создаётся заново —
 * поэтому смена модели в середине диалога стоит ровно ничего.
 */
export function resolveModel(modelId: string) {
  const id = isKnownModel(modelId) ? modelId : DEFAULT_MODEL_ID;
  return getProvider()(id);
}
