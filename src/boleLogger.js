import assert from 'assert';

export default function boleWinston(logger, levels = ['debug', 'info', 'warn', 'error']) {
  assert(logger, 'If rabbot logging is enabled, a logger must be configured');
  const stream = {
    _writableState: { objectMode: true },
    write(data) {
      const { level, name, message, hostname, time, ...rest } = data;
      logger[level](message, rest);
    },
  };
  return levels.map(level => ({ level, stream }));
}
