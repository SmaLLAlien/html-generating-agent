import { hasToolCall, stepCountIs, streamText, type ModelMessage } from 'ai';
import { CONTEXT_BUDGET_TOKENS, MAX_AGENT_STEPS } from './config.js';
import type { EmitEvent } from './events.js';
import { evictOldWidgets } from './memory.js';
import { resolveModel } from './models.js';
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

ПРАВИЛА ДИАЛОГА:
- Общайся на русском, вежливо, обращайся к пользователю по имени.
- Если требования неполные, задай 1–2 уточняющих вопроса, но при возможности сразу предложи первый вариант виджета.
- Если пользователь ссылается на прошлый вариант неоднозначно («верни как было», «тот, с иконкой») — сверься с каталогом вариантов и уточни номер, прежде чем работать.
- Когда пользователь явно одобряет виджет (приходит сообщение о нажатии кнопки «Принять» или он пишет «принимаю», «подходит», «одобряю») — поблагодари, кратко попрощайся и вызови finishDialog.`;
}

/**
 * Эфемерная подсказка со списком всех вариантов — без кода, ~10 токенов на вариант.
 * Ставится в хвост перед сообщением пользователя (не в системный промпт, иначе
 * каждый ход инвалидируется префиксный кеш) и не сохраняется в историю.
 */
function catalogMessages(session: ChatSession): ModelMessage[] {
  if (!session.variants.length) return [];

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

  return [
    {
      role: 'user',
      content:
        `[Каталог вариантов] ${list}. ` +
        'Полный код любого из них можно получить инструментом getVariant.',
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
    messages: [...session.messages, ...catalogMessages(session), userMessage],
    tools: buildTools(session, emit),
    stopWhen: [stepCountIs(MAX_AGENT_STEPS), hasToolCall('finishDialog')],
    temperature: 0.7,
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
  const contextTokens =
    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || session.contextTokens;
  session.contextTokens = contextTokens;

  emit({
    type: 'usage',
    contextTokens,
    budget: CONTEXT_BUDGET_TOKENS,
    percent: Math.round((contextTokens / CONTEXT_BUDGET_TOKENS) * 100),
  });

  return { finished, contextTokens };
}
