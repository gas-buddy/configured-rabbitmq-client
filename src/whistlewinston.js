const map = new WeakMap();
const defaultContext = {};

module.exports = function whistlepunkWinstonBridge(config) {
  const { context = defaultContext } = config;
  let adapter = map.get(context);
  if (!adapter) {
    adapter = {
      onLog(data) {
        if (context.logger && typeof context.logger[data.type] === 'function') {
          context.logger[data.type](`${data.namespace}: ${data.msg}`);
        }
      },
    };
    map.set(context, adapter);
  }
  return adapter;
};
