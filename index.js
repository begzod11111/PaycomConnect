import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';

import { env } from './config/env.js';
import apiRouter from './routes/api.js';
import indexRouter from './routes/index.js';
import { connectDatabase } from './services/databaseService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();


connectDatabase().then((state) => {
  if (state.mode === 'memory') {
    console.warn(`MongoDB is not connected; using memory store (${state.lastError})`);
  }
}).catch((error) => {
  console.error('MongoDB initialization failed:', error.message);
});

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || env.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS origin is not allowed: ${origin}`));
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    credentials: true,
  }),
);

app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/api', apiRouter);




app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl,
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(error.status || 500).json({
    error: error.message || 'Internal Server Error',
    stack: env.nodeEnv === 'development' ? error.stack : undefined,
  });
});

export default app;
