function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Рабочий бюджет контекста. Это не физическое окно модели (у gemini-2.5 оно ~1M),
 * а порог, на котором мы считаем историю раздутой: на 80% предупреждаем
 * пользователя, на 100% блокируем диалог и предлагаем начать новый.
 * Автосжатие истории сознательно не делается — см. docs/agent-architecture.md.
 */
export const CONTEXT_BUDGET_TOKENS = readInt('CONTEXT_BUDGET_TOKENS', 300_000);

/** Доля бюджета, на которой показываем предупреждение */
export const CONTEXT_WARN_RATIO = 0.8;

/** Максимум шагов агентного цикла за один ход пользователя */
export const MAX_AGENT_STEPS = readInt('MAX_AGENT_STEPS', 6);
