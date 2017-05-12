import _ from 'lodash';

const exchangeDefaults = {
  type: 'direct',
  durable: true,
  autoDelete: false,
};

const queueDefaults = {
  autoDelete: false,
  durable: true,
  noAck: false,
};

export default function (shorthandConfigs) {
  const output = {
    exchanges: [],
    queues: [],
    bindings: [],
  };

  function addBinding(exchange, queue, keys) {
    output.exchanges.push(exchange);
    output.queues.push(queue);
    output.bindings.push({
      exchange: exchange.name,
      target: queue.name,
      keys:keys,
    });
  }

  shorthandConfigs.forEach((c) => {
    const keys = c.keys;
    if (!keys) {
      throw new Error('Must specify keys');
    }

    let exchange = _.isString(c.exchange) ? { name: c.exchange } : c.exchange;
    if (!exchange.name) {
      throw new Error('Exchanges must be named.');
    }
    exchange = Object.assign({}, exchangeDefaults, exchange);

    let queue = (_.isString(c.queue) ? { name: c.queue } : c.queue) || {};
    if (!queue.name) {
      throw new Error('Queues must be named.');
    }
    queue = Object.assign({}, queueDefaults, queue);

    if (!c.noRetry) {
      const retryExchange = Object.assign({}, exchange);
      retryExchange.name = `${retryExchange.name}.retry`;

      const retryQueue = Object.assign({}, queue);
      retryQueue.name = `${retryQueue.name}.retry`;
      retryQueue.messageTtl = 250;
      retryQueue.deadLetter = exchange.name;

      addBinding(retryExchange, retryQueue, keys);

      const rejectedExchange = Object.assign({}, exchange);
      rejectedExchange.name = `${exchange.name}.rejected`;

      const rejectedQueue = Object.assign({}, queue);
      rejectedQueue.name = `${queue.name}.rejected`;

      addBinding(rejectedExchange, rejectedQueue, keys);

      queue.deadLetter = rejectedExchange.name;
    }

    addBinding(exchange, queue, keys);
  });
  return output;
}
