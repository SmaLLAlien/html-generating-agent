import { hasToolCall, stepCountIs, streamText, type ModelMessage } from 'ai';
import { BRAND_GUIDE } from './brand.js';
import {
  CONTEXT_BUDGET_TOKENS,
  CONTEXT_WARN_RATIO,
  MAX_AGENT_STEPS,
} from './config.js';
import type { EmitEvent } from './events.js';
import { evictOldWidgets } from './memory.js';
import { callSettingsFor, resolveModel } from './models.js';
import type { ChatSession, UserInfo } from './sessions.js';
import { buildTools } from './tools.js';

export { stripJavaScript } from './tools.js';

function buildSystemPrompt(user: UserInfo): string {
  return `Ты — ассистент-верстальщик, который помогает сотруднику создавать HTML-виджеты.

Данные пользователя (используй их для персонализации общения и, если попросят, внутри виджета):
- ФИО: ${user.fullName}
- LDAP: ${user.ldap}

ИНСТРУМЕНТЫ:
- emitWidget — ЕДИНСТВЕННЫЙ способ показать виджет пользователю. Вызывай его каждый раз, когда создаёшь или изменяешь виджет.
- getVariant — получить полный код ранее созданного варианта по номеру.
- finishDialog — завершить диалог после явного одобрения виджета.

ЖЁСТКИЕ ПРАВИЛА ДЛЯ ВИДЖЕТОВ:
1. Виджет — это ТОЛЬКО HTML и CSS. Никакого JavaScript: запрещены теги <script>, атрибуты-обработчики (onclick, onload и т.п.), ссылки javascript:, а также <iframe>, <object>, <embed>. Если инструмент отклонил код — исправь нарушения и вызови его заново.
2. Стили — инлайновые (style="...") или в теге <style> внутри виджета. Виджет должен быть самодостаточным фрагментом: его можно вставить в любую страницу как есть.
3. В emitWidget всегда клади ПОЛНЫЙ код виджета (не диф, не фрагмент изменений).
4. НИКОГДА не пиши HTML-код виджета в тексте ответа — ни целиком, ни кусками, ни в блоке кода. Пользователь видит виджет из emitWidget. В тексте — только описание, вопросы и пояснения.
5. Если ты дорабатываешь существующий вариант — укажи его номер в basedOn.
6. Код старых вариантов в истории заменён пометкой и тебе не виден. Если он нужен — вызови getVariant с номером. Номера вариантов не переиспользуются: доработка варианта #1 создаёт новый вариант со следующим свободным номером.

${BRAND_GUIDE}

ПРАВИЛА ДИАЛОГА:
- Общайся на русском, вежливо, обращайся к пользователю по имени.
- Если требования неполные, задай 1–2 уточняющих вопроса, но при возможности сразу предложи первый вариант виджета.
- Если пользователь ссылается на прошлый вариант неоднозначно («верни как было», «тот, с иконкой») — сверься с каталогом вариантов и уточни номер, прежде чем работать.
- Перед каждым ходом ты получаешь блок [Состояние] с датой, номером хода и заполненностью контекста. Используй его: не выдумывай дату и не спрашивай её у пользователя.
- Если контекст заполнен больше чем на ${Math.round(CONTEXT_WARN_RATIO * 100)}%, предупреди пользователя, что диалог скоро придётся начать заново, и предложи закончить текущий виджет. При 100% диалог блокируется — не доводи до этого молча.
- Если правок уже много и они ходят по кругу (пользователь возвращает то, что просил убрать), не выдавай очередной вариант молча — спроси, что именно не устраивает.
- Когда пользователь явно одобряет виджет (приходит сообщение о нажатии кнопки «Принять» или он пишет «принимаю», «подходит», «одобряю») — поблагодари, кратко попрощайся и вызови finishDialog.`;
}

function formatNow(): string {
  return new Date().toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function variantCatalog(session: ChatSession): string {
  if (!session.variants.length) return 'Вариантов пока нет.';

  const latest = session.variants.at(-1)!.n;
  const list = session.variants
    .map((v) => {
      const marks: string[] = [];
      if (v.n === latest) marks.push('текущий');
      if (v.accepted) marks.push('принят');
      if (v.basedOn != null) marks.push(`на основе #${v.basedOn}`);
      return `#${v.n} «${v.title}»${marks.length ? ` (${marks.join(', ')})` : ''}`;
    })
    .join('; ');

  return `${list}. Полный код любого из них — инструментом getVariant.`;
}

/**
 * Эфемерный блок состояния: дата, номер хода, заполненность контекста и каталог
 * вариантов без кода. Всё это меняется каждый ход, поэтому кладётся В ХВОСТ
 * перед сообщением пользователя, а не в системный промпт — иначе префиксный кеш
 * Gemini инвалидировался бы на каждом вызове. В историю не сохраняется:
 * пересобирается заново перед каждым обращением к модели.
 */
function stateMessages(session: ChatSession): ModelMessage[] {
  const percent = Math.round(
    (session.contextTokens / CONTEXT_BUDGET_TOKENS) * 100
  );

  return [
    {
      role: 'user',
      content:
        `[Состояние] Сейчас ${formatNow()}. Ход №${session.turnCount + 1} в этом диалоге. ` +
        `Контекст заполнен на ${percent}% (${session.contextTokens} из ${CONTEXT_BUDGET_TOKENS} токенов).\n` +
        `[Варианты сессии] ${variantCatalog(session)}`,
    },
  ];
}

export interface AgentTurnResult {
  /** Агент вызвал finishDialog */
  finished: boolean;
  /** Сколько токенов займёт история на следующем вызове */
  contextTokens: number;
}

/**
 * Один ход агента. Текст стримится приращениями, виджет и завершение диалога
 * приезжают событиями из инструментов.
 */
export async function runAgent(
  session: ChatSession,
  userText: string,
  emit: EmitEvent
): Promise<AgentTurnResult> {
  const userMessage: ModelMessage = { role: 'user', content: userText };

  const result = streamText({
    model: resolveModel(session.modelId),
    system: buildSystemPrompt(session.user),
    messages: [...session.messages, ...stateMessages(session), userMessage],
    tools: buildTools(session, emit),
    stopWhen: [stepCountIs(MAX_AGENT_STEPS), hasToolCall('finishDialog')],
    // temperature и настройки мышления зависят от поколения модели
    ...callSettingsFor(session.modelId),
  });

  let finished = false;
  let emittedText = false;
  let textInStep = false;

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'start-step':
        textInStep = false;
        break;

      case 'text-delta':
        // Между шагами модель может заговорить снова — разделяем абзацем,
        // иначе реплики склеиваются в одно слово.
        if (!textInStep && emittedText) emit({ type: 'text', delta: '\n\n' });
        textInStep = true;
        emittedText = true;
        emit({ type: 'text', delta: part.text });
        break;

      case 'tool-call':
        if (part.toolName === 'finishDialog') finished = true;
        break;

      case 'error':
        throw part.error instanceof Error
          ? part.error
          : new Error(String(part.error));
    }
  }

  // Успех — фиксируем обмен в памяти агента.
  // response.messages содержит ответ ассистента вместе с вызовами инструментов
  // и сообщения с их результатами.
  const response = await result.response;
  session.messages.push(userMessage, ...response.messages);

  // Вытесняем код всех вариантов, кроме закреплённых. Делаем это сразу после
  // хода, чтобы уже следующий вызов ушёл с укороченной историей.
  const evicted = evictOldWidgets(session);
  if (evicted.evicted) {
    console.log(
      `[контекст] вытеснено ${evicted.evicted} фрагм., −${evicted.freedChars} симв.; ` +
        `в контексте целиком: ${evicted.pinned.map((n) => '#' + n).join(', ')}`
    );
  }

  // ВАЖНО: usage (последний шаг), а не totalUsage (сумма по всем шагам).
  // Каждый шаг агентного цикла переотправляет всю историю, поэтому totalUsage
  // на многошаговом ходе задваивает её и счётчик скачет вперёд-назад.
  // Размер истории для следующего вызова = вход последнего шага + его выход.
  const usage = await result.usage;
  // reasoningTokens сюда не входят: размышления модели оплачиваются, но в
  // историю не попадают — обратно уезжают только их подписи (thought signatures).
  // Отдельные модели семейства 3 иногда не отдают outputTokens вовсе, поэтому
  // сумма может оказаться нулевой — тогда оставляем прежнее значение.
  const contextTokens =
    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || session.contextTokens;
  session.contextTokens = contextTokens;
  session.turnCount++;

  const cachedTokens = await readCachedTokens(result, usage);

  // А вот размышления считаются наоборот — по totalUsage. Модель думает на
  // ПЕРВОМ шаге, перед вызовом инструмента, поэтому в usage последнего шага
  // reasoningTokens приходит undefined. Две метрики — два источника:
  // размер истории берём с последнего шага, стоимость размышлений — со всех.
  const reasoningTokens = (await result.totalUsage).reasoningTokens ?? 0;
  console.log(
    `[контекст] ход ${session.turnCount}: ${contextTokens} токенов` +
      (cachedTokens ? `, из них из кеша ${cachedTokens}` : ', кеш не сработал') +
      (reasoningTokens ? `; на размышления ${reasoningTokens}` : '')
  );

  emit({
    type: 'usage',
    contextTokens,
    budget: CONTEXT_BUDGET_TOKENS,
    percent: Math.round((contextTokens / CONTEXT_BUDGET_TOKENS) * 100),
    cachedTokens,
    reasoningTokens,
  });

  return { finished, contextTokens };
}

/**
 * Сколько входных токенов пришло из неявного кеша Gemini.
 *
 * Явное кеширование (CachedContent) для этого проекта недоступно: минимум
 * 32768 токенов на кеш, а диалоги здесь — единицы тысяч. Зато неявное включено
 * по умолчанию на всех моделях 2.5 и даёт вход по 10% цены. Единственное, что
 * от нас требуется — стабильный префикс запроса и измерение попаданий.
 *
 * Сначала пробуем портируемое поле AI SDK, затем — сырой ответ Gemini.
 */
async function readCachedTokens(
  result: { providerMetadata: Promise<Record<string, unknown> | undefined> },
  usage: { cachedInputTokens?: number | undefined }
): Promise<number> {
  if (typeof usage.cachedInputTokens === 'number') {
    return usage.cachedInputTokens;
  }
  const meta = (await result.providerMetadata) as
    | { google?: { usageMetadata?: { cachedContentTokenCount?: number | null } } }
    | undefined;
  return meta?.google?.usageMetadata?.cachedContentTokenCount ?? 0;
}
