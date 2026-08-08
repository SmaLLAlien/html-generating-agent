/**
 * Минимальное структурное логирование.
 *
 * До этого логи были прозой без единого идентификатора: на жалобу «бот замолчал»
 * привязаться было не к чему. Теперь в каждой строке есть сессия и пользователь,
 * так что инцидент можно проследить целиком.
 *
 * Полноценный логгер (pino и т.п.) сюда не тащим — зависимость ради формата
 * не окупается, а строки всё равно уходят в stdout.
 */

export interface LogContext {
  sessionId?: string;
  ldap?: string;
  turn?: number;
  model?: string;
}

/** Полный UUID в логах читать невозможно, а восьми знаков хватает для склейки */
function shortId(id: string | undefined): string {
  return id ? id.slice(0, 8) : '-';
}

function format(
  level: string,
  event: string,
  ctx: LogContext,
  data: Record<string, unknown>
): string {
  const parts = [
    `[${level}]`,
    event,
    `sid=${shortId(ctx.sessionId)}`,
    `user=${ctx.ldap ?? '-'}`,
  ];
  if (ctx.turn != null) parts.push(`turn=${ctx.turn}`);
  if (ctx.model) parts.push(`model=${ctx.model}`);
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return parts.join(' ');
}

export function logInfo(
  event: string,
  ctx: LogContext,
  data: Record<string, unknown> = {}
): void {
  console.log(format('info', event, ctx, data));
}

export function logWarn(
  event: string,
  ctx: LogContext,
  data: Record<string, unknown> = {}
): void {
  console.warn(format('warn', event, ctx, data));
}

export function logError(
  event: string,
  ctx: LogContext,
  data: Record<string, unknown> = {}
): void {
  console.error(format('error', event, ctx, data));
}
