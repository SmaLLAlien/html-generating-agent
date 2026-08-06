import 'dotenv/config';
import express, { Request, Response } from 'express';
import { chatRouter } from './chat.router.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(express.json({ limit: '1mb' }));

app.get('/', (_req: Request, res: Response) => {
  res.send('TypeScript Express сервер працює!');
});

app.use('/api/chat', chatRouter);

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущено на http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    console.warn(
      '⚠️  GEMINI_API_KEY не задан. Створіть my-express-server/.env за зразком .env.example'
    );
  }
});
