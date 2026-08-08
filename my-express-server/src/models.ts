import {
  createGoogleGenerativeAI,
  type GoogleGenerativeAIProvider,
} from '@ai-sdk/google';

export interface ModelInfo {
  id: string;
  label: string;
  /** Размер контекстного окна модели, токенов */
  contextWindow: number;
  hint: string;
}

/** Доступные модели. Провайдер один — Google Gemini. */
export const MODELS: readonly ModelInfo[] = [
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    contextWindow: 1_048_576,
    hint: 'Точнее и надёжнее с инструментами, но медленнее',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    contextWindow: 1_048_576,
    hint: 'Баланс скорости и качества',
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    contextWindow: 1_048_576,
    hint: 'Самая быстрая и дешёвая',
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
