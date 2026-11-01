export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(debug: boolean): Logger {
  const prefix = '[klovplay]';
  return {
    debug: (message) => {
      if (debug) console.log(`${prefix} ${message}`);
    },
    info: (message) => console.log(`${prefix} ${message}`),
    warn: (message) => console.warn(`${prefix} ${message}`),
    error: (message) => console.error(`${prefix} ${message}`),
  };
}
