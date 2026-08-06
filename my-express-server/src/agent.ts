import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from '@ai-sdk/google';
import { streamObject, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { ChatSession, UserInfo } from './sessions.js';

/**
 * Структурированный ответ агента.
 * Порядок полей важен: message идёт первым, чтобы текст стримился раньше HTML.
 */
export const agentResponseSchema = z.object({
  message: z
    .string()
    .describe(
      'Текстовый ответ пользователю на русском языке. НИКОГДА не вставляй сюда HTML-код виджета.'
    ),
  widgetHtml: z
    .string()
    .nullable()
    .describe(
      'Полный самодостаточный HTML-код виджета БЕЗ JavaScript, если в этом ответе есть новая или обновлённая версия виджета. Если виджета в ответе нет (уточняющий вопрос, обычный ответ, прощание) — null.'
    ),
  canClose: z
    .boolean()
    .describe(
      'true ТОЛЬКО когда пользователь явно одобрил/принял виджет и диалог можно завершать. Во всех остальных случаях false.'
    ),
});

export type AgentResponse = z.infer<typeof agentResponseSchema>;

const DEFAULT_MODEL = 'gemini-2.5-flash';

let provider: GoogleGenerativeAIProvider | null = null;

function getModel() {
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
  return provider(process.env.GEMINI_MODEL ?? DEFAULT_MODEL);
}

function buildSystemPrompt(user: UserInfo): string {
  return `Ты — ассистент-верстальщик, который помогает сотруднику создавать HTML-виджеты.

Данные пользователя (используй их для персонализации общения и, если попросят, внутри виджета):
- ФИО: ${user.fullName}
- LDAP: ${user.ldap}

ЖЁСТКИЕ ПРАВИЛА ДЛЯ ВИДЖЕТОВ:
1. Виджет — это ТОЛЬКО HTML и CSS. Никакого JavaScript: запрещены теги <script>, атрибуты-обработчики (onclick, onload и т.п.), ссылки javascript:, а также <iframe>, <object>, <embed>.
2. Стили — инлайновые (style="...") или в теге <style> внутри виджета. Виджет должен быть самодостаточным фрагментом: его можно вставить в любую страницу как есть.
3. Каждый раз, когда ты создаёшь или изменяешь виджет, клади его ПОЛНЫЙ код (не диф, не фрагмент изменений) в поле widgetHtml.
4. В поле message — только текст: описание, вопросы, пояснения. Код виджета в message НЕ дублируй.
5. Если ответ не содержит виджет (уточняющий вопрос, совет, прощание) — widgetHtml = null.

ПРАВИЛА ДИАЛОГА:
- Общайся на русском, вежливо, обращайся к пользователю по имени.
- Если требования неполные, задай 1–2 уточняющих вопроса, но при возможности сразу предложи первый вариант виджета.
- Когда пользователь явно одобряет виджет (например, приходит сообщение о нажатии кнопки «Принять» или он пишет «принимаю», «подходит», «одобряю») — поблагодари, кратко попрощайся и верни canClose = true (widgetHtml в этом ответе = null).
- Во всех остальных ответах canClose = false.`;
}

/** Подстраховка: вырезаем любой JavaScript, если модель нарушила правила */
export function stripJavaScript(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

/**
 * Запускает агента для одного сообщения пользователя.
 * История берётся из сессии; при успехе сообщение пользователя и ответ
 * агента дописываются в память сессии.
 */
export async function runAgent(
  session: ChatSession,
  userText: string,
  onPartial: (partial: { message: string }) => void
): Promise<AgentResponse> {
  const userMessage: ModelMessage = { role: 'user', content: userText };
  const messages: ModelMessage[] = [...session.messages, userMessage];

  const result = streamObject({
    model: getModel(),
    schema: agentResponseSchema,
    system: buildSystemPrompt(session.user),
    messages,
    temperature: 0.7,
  });

  for await (const partial of result.partialObjectStream) {
    if (typeof partial.message === 'string') {
      onPartial({ message: partial.message });
    }
  }

  const finalObject = await result.object;

  const response: AgentResponse = {
    ...finalObject,
    widgetHtml: finalObject.widgetHtml
      ? stripJavaScript(finalObject.widgetHtml)
      : null,
  };

  // Успех — фиксируем обмен в памяти агента
  session.messages.push(userMessage, {
    role: 'assistant',
    content: JSON.stringify(response),
  });

  return response;
}
