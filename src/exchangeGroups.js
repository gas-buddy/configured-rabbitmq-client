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

function groupFromInput(param, defaultName) {
  let returnVal = {};
  if (_.isString(param)) {
    returnVal = { name: param };
  } else if (_.isObject(param)) {
    returnVal = param;
  }

  returnVal.name = returnVal.name || defaultName;
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

  normalized.exchange = groupFromInput(group.exchange, key);
  const exchangeName = normalized.exchange.name;

  normalized.queue = groupFromInput(group.queue, `${exchangeName}.q`);

  if (normalized.retries) {
    normalized.retryExchange = groupFromInput(group.retryExchange, `${exchangeName}.retry`);
    normalized.retryQueue = groupFromInput(group.retryQueue, `${normalized.retryExchange.name}.q`);
  }

  if (normalized.retries || group.rejectedExchange || group.rejectedQueue) {
    normalized.rejectedExchange = groupFromInput(group.rejectedExchange, `${exchangeName}.rejected`);
    normalized.rejectedQueue = groupFromInput(group.rejectedQueue, `${normalized.rejectedExchange.name}.q`);
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

function addBinding(rabbotConfig, exchange, queue, keys) {
  rabbotConfig.exchanges.push(exchange);
  rabbotConfig.queues.push(queue);
  rabbotConfig.bindings.push({
    exchange: exchange.name,
    target: queue.name,
    keys,
  });
}

export function rabbotConfigFromExchangeGroups(exchangeGroups) {
  const rabbotConfig = {
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
      retryQueue.messageTtl = g.retryDelay;
      retryQueue.deadLetter = exchange.name;

      addBinding(rabbotConfig, retryExchange, retryQueue, g.keys);
    }

    if (g.rejectedExchange) {
      const rejectedExchange = Object.assign({}, exchangeDefaults, g.rejectedExchange);
      const rejectedQueue = Object.assign({}, queueDefaults, g.rejectedQueue);

      addBinding(rabbotConfig, rejectedExchange, rejectedQueue, g.keys);

      queue.deadLetter = rejectedExchange.name;
    }

    addBinding(rabbotConfig, exchange, queue, g.keys);
  });

  return rabbotConfig;
}
