// util/logger.js
// pino singleton. Pretty in dev, JSON in prod (NODE_ENV=production).
//
// Every warn / error / fatal anywhere in the pipeline is also handed to an
// issue sink (util/issues.js), which keeps it where the applicant can see it:
// the /run and /send replies, the daily notification, and /issues. Before this
// those lines existed only in Railway's log stream, so from Telegram a failure
// looked like silence or a quietly incomplete result. One hook here covers all
// existing call sites; nothing else has to change to be reported.
import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

let issueSink = null;

/** Registered by util/issues.js. Kept as a setter to avoid an import cycle. */
export function setIssueSink(fn) {
  issueSink = typeof fn === 'function' ? fn : null;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  hooks: {
    logMethod(inputArgs, method, level) {
      if (level >= 40 && issueSink) issueSink(level, inputArgs);
      return method.apply(this, inputArgs);
    },
  },
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
