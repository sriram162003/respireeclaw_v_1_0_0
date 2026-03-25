import pino from 'pino';
import os from 'os';
import path from 'path';
import fs from 'fs';

const LOG_DIR = path.join(os.homedir(), '.aura', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const isDev = process.env.NODE_ENV !== 'production';
const alwaysLogToFile = process.env.LOG_TO_FILE === 'true';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    hostname: os.hostname(),
    service: 'aura-gateway',
  },
});

export const createChildLogger = (module: string) => logger.child({ module });

export const logFilePath = path.join(LOG_DIR, 'aura.log');
export const errorLogPath = path.join(LOG_DIR, 'error.log');

if (!isDev || alwaysLogToFile) {
  const fileLogger = pino({}, pino.destination(logFilePath));
  const errorLogger = pino({}, pino.destination(errorLogPath));
  
  logger.addListener('level-change', (lev, log) => {
    const dest = lev === 'error' || lev === 'fatal' ? errorLogger : fileLogger;
    dest.info(log);
  });
}
