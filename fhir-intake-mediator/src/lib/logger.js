import pino from 'pino';

export function createLogger(nodeEnv) {
  return pino({
    level: nodeEnv === 'production' ? 'info' : 'debug',
    transport: nodeEnv === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
  });
}
