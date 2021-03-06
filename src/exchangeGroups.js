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

function groupFromInput(param, { name, persistent }) {
  let returnVal = {};
  if (_.isString(param)) {
    returnVal = { name: param };
  } else if (_.isObject(param)) {
    returnVal = param;
  }
  returnVal.name = returnVal.name || name;
  returnVal.persistent = returnVal.persistent || persistent;
  return returnVal;
}

function normalizeExchangeGroup(key, group) {
  if (!group.keys) {
    throw new Error('Must specify keys for each group');
  }

  const normalized = {
    readLimit: group.readLimit || 100,
    retryDelay: group.retryDelay || 10000,
    retries: _.isNumber(group.retries) ? group.retries : 5,
    keys: group.keys,
  };
  const persistent = group.persistent || false;

  normalized.exchange = groupFromInput(group.exchange, { name: key, persistent });
  const exchangeName = normalized.exchange.name;

  normalized.queue = groupFromInput(group.queue, { name: `${exchangeName}.q` });

  if (normalized.retries) {
    normalized.retryExchange = groupFromInput(group.retryExchange, { name: `${exchangeName}.retry`, persistent });
    normalized.retryQueue = groupFromInput(group.retryQueue, { name: `${normalized.retryExchange.name}.q` });
    const ttlKey = group.perMessageTtl === true ? 'perMessageTtl' : 'messageTtl';
    normalized.retryQueue[ttlKey] = normalized.retryDelay;
  }

  if (normalized.retries || group.rejectedExchange || group.rejectedQueue) {
    normalized.rejectedExchange = groupFromInput(group.rejectedExchange, { name: `${exchangeName}.rejected`, persistent });
    normalized.rejectedQueue = groupFromInput(group.rejectedQueue, { name: `${normalized.rejectedExchange.name}.q` });
  }

  return normalized;
}

export function normalizeExchangeGroups(exchangeGroups) {
  const normalized = {};

  Object.entries(exchangeGroups).forEach(([k, v]) => {
    normalized[k] = normalizeExchangeGroup(k, v);
  });

  return normalized;
}

function addBinding(fooFooConfig, exchange, queue, keys) {
  fooFooConfig.exchanges.push(exchange);
  fooFooConfig.queues.push(queue);
  fooFooConfig.bindings.push({
    exchange: exchange.name,
    target: queue.name,
    keys,
  });
}

export function fooFooConfigFromExchangeGroups(exchangeGroups) {
  const foofooConfig = {
    exchanges: [],
    queues: [],
    bindings: [],
  };

  Object.entries(exchangeGroups).forEach(([, g]) => {
    const exchange = Object.assign({}, exchangeDefaults, g.exchange);
    const queue = Object.assign({}, queueDefaults, g.queue);
    queue.limit = g.readLimit;

    if (g.retryExchange) {
      const retryExchange = Object.assign({}, exchangeDefaults, g.retryExchange);
      const retryQueue = Object.assign({}, queueDefaults, g.retryQueue);
      retryQueue.deadLetter = exchange.name;
      addBinding(foofooConfig, retryExchange, retryQueue, g.keys);
    }

    if (g.rejectedExchange) {
      const rejectedExchange = Object.assign({}, exchangeDefaults, g.rejectedExchange);
      const rejectedQueue = Object.assign({}, queueDefaults, g.rejectedQueue);

      addBinding(foofooConfig, rejectedExchange, rejectedQueue, g.keys);

      queue.deadLetter = rejectedExchange.name;
    }

    addBinding(foofooConfig, exchange, queue, g.keys);
  });

  return foofooConfig;
}
