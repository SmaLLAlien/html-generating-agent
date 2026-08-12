# ai-widgets

Angular-клиент помощника по виджетам: плавающий чат, превью виджетов, выбор модели
и индикатор расхода контекста.

Сам по себе не работает — нужен сервер из `../my-express-server`, иначе запросы к `/api`
уходить некуда. Запуск обоих пакетов, переменные окружения и описание API —
в **[корневом README](../README.md)**.

```bash
npm start
```

Поднимет дев-сервер на `http://localhost:4200` и проксирует `/api` на
`http://localhost:3000` согласно `proxy.conf.json`.

Остальные команды стандартные для Angular CLI: `npm run build`, `npm test`,
`npx ng generate component <name>`.
