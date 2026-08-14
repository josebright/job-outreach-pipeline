// util/logger.js
// pino singleton. Pretty in dev, JSON in prod (NODE_ENV=production).
import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(isProd ? {} : {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, singleLine: false, translateTime: 'HH:MM:ss.l' },
    },
  }),
});

export function child(bindings) {
  return logger.child(bindings);
}
