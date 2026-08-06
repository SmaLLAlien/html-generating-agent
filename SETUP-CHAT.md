# Чат с агентом для создания HTML-виджетов

## Что сделано

- **Сервер** (`my-express-server`) — агент на базе **Vercel AI SDK** (opensource, MIT) + Gemini:
  - `POST /api/chat/session` — старт диалога, принимает `{ ldap, fullName }`, возвращает `sessionId`;
  - `POST /api/chat/:sessionId/message` — сообщение агенту, ответ стримится по SSE;
  - `DELETE /api/chat/:sessionId` — завершение диалога (память сессии удаляется);
  - память агента — история диалога в `Map` по `sessionId` (в памяти процесса, TTL 2 часа);
  - структурированный ответ модели (Zod-схема): `message` (текст), **`widgetHtml` (код виджета отдельным полем)**, `canClose` (признак «пользователь одобрил, чат можно закрывать»);
  - системный промпт запрещает JavaScript в виджетах + серверная подстраховка `stripJavaScript()`.

- **Клиент** (`ai-widgets`) — чат на Angular:
  - стартовая форма LDAP + ФИО → создание сессии;
  - стриминг текста ответа, живое превью виджета в `<iframe sandbox>`;
  - под каждым виджетом кнопки **«Принять»**, «Показать код», «Скопировать код»;
  - кнопка **«Завершить диалог»** (подсвечивается, когда агент вернул `canClose: true`);
  - dev-прокси `/api` → `http://localhost:3000` (файл `proxy.conf.json`).

## Куда положить ключ

Создайте файл `my-express-server/.env` (рядом с `package.json` сервера) по образцу
`my-express-server/.env.example`:

```
GEMINI_API_KEY=ваш_ключ
```

`.env` уже в `.gitignore` — в git он не попадёт, и в переписку его вставлять не нужно.

## Запуск

1. Установить новые зависимости сервера:

   ```
   cd my-express-server
   npm install
   npm run dev
   ```

2. В другом терминале — клиент:

   ```
   cd ai-widgets
   npm start
   ```

3. Открыть http://localhost:4200, ввести LDAP и ФИО, начать диалог.

## Формат SSE-событий (если нужно дергать API напрямую)

```
data: {"type":"partial","message":"текст по мере генерации"}
data: {"type":"final","message":"...","widgetHtml":"<div>...</div>","canClose":false}
data: {"type":"error","error":"описание ошибки"}
```

`widgetHtml` в событии `final` — это полный код виджета отдельным полем: его можно
забирать программно и вставлять в другой запрос, не вырезая из текста сообщения.

Кнопка «Принять» отправляет `{ "action": "accept" }` — модель отвечает прощанием и
`canClose: true`.

## Настройки

- Модель по умолчанию — `gemini-2.5-flash`. Поменять: `GEMINI_MODEL=gemini-2.5-pro` в `.env`.
- Порт сервера: `PORT` в `.env` (по умолчанию 3000; при смене поправьте `ai-widgets/proxy.conf.json`).
