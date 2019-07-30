import { EventEmitter } from 'events';
import assert from 'assert';
import rabbot from 'rabbot';
import _ from 'lodash';
import {
  normalizeExchangeGroups,
  rabbotConfigFromExchangeGroups,
} from './exchangeGroups';
import { WrappedMessage } from './WrappedMessage';
import boleLogger from './boleLogger';

const exchangeErrorRE = /Failed to create exchange '(.*)' on connection 'default'/;
const ORIGINAL_ARGS = Symbol('Original rabbitmq options');

function isDev() {
  return process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
}

async function delay(ms) {
  return new Promise(accept => setTimeout(accept, ms));
}

function finalConfigFromConfig(context, opts, mqConnectionConfig) {
  let exchangeGroups = (opts.config && opts.config.exchangeGroups) || {};
  exchangeGroups = normalizeExchangeGroups(exchangeGroups);

  const exchangeGroupConfig = rabbotConfigFromExchangeGroups(exchangeGroups);
  const finalConfig = Object.assign({}, opts.config);
  delete finalConfig.exchangeGroups;

  finalConfig.exchanges = (finalConfig.exchanges || []).concat(exchangeGroupConfig.exchanges);
  finalConfig.queues = (finalConfig.queues || []).concat(exchangeGroupConfig.queues);
  finalConfig.bindings = (finalConfig.bindings || []).concat(exchangeGroupConfig.bindings);
  finalConfig.connection = Object.assign({}, finalConfig.connection, mqConnectionConfig);

  let dependencies = (opts.config && opts.config.dependencies) || [];

  const dependencyAttribs = {};
  // Create dependencies in test mode.
  if (process.env.NODE_ENV !== 'test') {
    dependencyAttribs.passive = true;
  }
  dependencies = _.map(dependencies, d => Object.assign({ name: d }, dependencyAttribs));

  finalConfig.exchanges = finalConfig.exchanges.concat(dependencies);

  if (opts.logging) {
    rabbot.log(boleLogger(context.logger, Array.isArray(opts.logging) ? opts.logging : undefined));
  }

  finalConfig.exchangeGroups = exchangeGroups;
  return finalConfig;
}

export default class RabbotClient extends EventEmitter {
  constructor(context, opts) {
    super();
    assert(opts, 'configured-rabbitmq-client must be passed arguments');
    assert(opts.username, 'configured-rabbitmq-client missing username setting');
    assert(opts.password, 'configured-rabbitmq-client missing password setting');

    context.logger.info('Initializing RabbitMQ client', {
      user: opts.username,
      host: opts.hostname || 'rabbitmq',
    });
    const mqConnectionConfig = {
      // In our usage, we've found that a short timeout causes trouble
      // on startup with spurious connection errors just because the box
      // is busy. So we default to a higher initial timeout
      timeout: 15000,
      // We don't typically use reply queues and they tend to cruft up
      // the server, so disable by default
      replyQueue: false,
      ...opts.connectionOptions,
      user: opts.username,
      pass: opts.password,
      host: opts.hostname || 'rabbitmq',
      port: opts.port || 5672,
      vhost: opts.basePath || '/',
    };

    // Event handlers need to be cleaned up afterwards...
    this.connSubscription = rabbot.on('connected', () => {
      context.logger.info('RabbitMQ connection established.');
    });

    this[ORIGINAL_ARGS] = { opts, mqConnectionConfig };
    this.finalConfig = finalConfigFromConfig(context, opts, mqConnectionConfig);
    this.exchangeGroups = this.finalConfig.exchangeGroups;
    delete this.finalConfig.exchangeGroups;
    this.originalContext = context;
    this.contextFunction = opts.contextFunction;
    this.startedCalled = false;
    this.subs = [];
    this.client = rabbot;
    this.subscriptions = opts.subscriptions;
  }

  // Function should recieve a queue message and return a gb-services style context.

  publish(...args) {
    return this.client.publish(...args);
  }

  request(...args) {
    return this.client.request(...args);
  }

  bulkPublish(...args) {
    return this.client.bulkPublish(...args);
  }

  async start(context) {
    assert(!this.startCalled, 'start called multiple times on configured-rabbitmq-client instance');
    this.startCalled = true;

    const maxRetries = 5;
    for (let retries = maxRetries; retries >= 0; retries -= 1) {
      try {
        context.logger.info('Configuring rabbot');
        // eslint-disable-next-line no-await-in-loop
        await rabbot.configure(this.finalConfig);
        break;
      } catch (stringError) {
        if (process.env.MQ_MAKE_EXCHANGES && exchangeErrorRE.test(stringError.message)) {
          const [, failedQueue] = stringError.message.match(exchangeErrorRE);
          const { opts, mqConnectionConfig } = this[ORIGINAL_ARGS];
          _.pull(opts.config.dependencies, failedQueue);
          opts.config.exchangeGroups = opts.config.exchangeGroups || {};
          opts.config.exchangeGroups[failedQueue] = { keys: '*' };
          this.finalConfig = finalConfigFromConfig(context, opts, mqConnectionConfig);
          this.exchangeGroups = this.finalConfig.exchangeGroups;
          delete this.finalConfig.exchangeGroups;
          retries += 1; // this one doesn't count

          // Unforunately, rabbot seems to need time to sort its sh** out.
          context.logger.info('Queue setup failed. Waiting 2.5s then creating queue', { name: failedQueue });
          // eslint-disable-next-line no-await-in-loop
          await delay(2500);
        }
        if (retries) {
          // This comparison basically is only false when we've done the auto-create thing above
          if (retries <= maxRetries) {
            context.logger.warn(`Queue configuration failed, retrying ${retries} more times`, stringError);
            if (isDev() && exchangeErrorRE.test(stringError)) {
              context.logger.info(`
*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*

Exchanges are missing. Typically this comes from dependent services which you are not
running. In order to create these queues with default characteristics, set
the MQ_MAKE_EXCHANGES environment variable and restart.

*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*`);
            }
          }

          try {
            // eslint-disable-next-line no-await-in-loop
            await rabbot.shutdown();
            rabbot.reset();
            context.logger.info('Rabbot cleanup complete');
          } catch (inner) {
            context.logger.warn('Rabbot cleanup failed', {
              error: inner.message,
              stack: inner.stack,
            });
          }

          if (retries <= maxRetries) {
            // eslint-disable-next-line no-await-in-loop
            await delay((1 + (maxRetries - retries)) * 2000);
          }
        } else {
          if (typeof stringError === 'string') {
            throw new Error(stringError);
          }
          throw stringError;
        }
      }
    }

    rabbot.nackUnhandled();
    rabbot.nackOnError();

    if (typeof this.subscriptions === 'object') {
      for (const [, sub] of Object.entries(this.subscriptions)) {
        this.subscribe(sub.queue, sub.type, sub.handler);
      }
    }

    this.closeSubscription = rabbot.on('closed', () => {
      if (!this.shuttingDown) {
        context.logger.error('RabbitMQ connection was closed.');
      }
    });
    this.unreachSubscription = rabbot.on('unreachable', () => {
      // TODO shutdown the process?
      context.logger.error('RabbitMQ connection has failed permanently.');
    });
    this.failSubscription = rabbot.onReturned('failed', (e) => {
      context.logger.error('RabbitMQ connection has failed.', {
        error: e.message,
        stack: e.stack,
      });
    });

    return this;
  }

  async stop(context) {
    assert(this.startCalled, 'stop called multiple times on configured-rabbitmq-client instance');
    context.logger.info('Closing RabbitMQ connection');
    await Promise.all(this.subs.map((s) => {
      s[0].remove();
      return RabbotClient.gracefulQueueShutdown(s[1]);
    }));
    this.shuttingDown = true;
    this.connSubscription.unsubscribe();
    delete this.connSubscription;
    if (this.closeSubscription) {
      this.closeSubscription.unsubscribe();
      delete this.closeSubscription;
    }
    if (this.unreachSubscription) {
      this.unreachSubscription.unsubscribe();
      delete this.unreachSubscription;
    }
    await rabbot.shutdown();
    rabbot.reset();
    this.startCalled = false;
  }

  async subscribe(queueName, type, handler) {
    if (process.env.DISABLE_RABBITMQ_SUBSCRIPTIONS === 'true') {
      return;
    }
    if (process.env.DISABLE_RABBITMQ_SUBSCRIPTIONS) {
      const disabled = process.env.DISABLE_RABBITMQ_SUBSCRIPTIONS.split(',');
      if (disabled.includes(queueName) || disabled.includes(`${queueName}$${type}`)) {
        return;
      }
    }

    let wrappedHandler = async (rabbotMessage) => {
      const message = new WrappedMessage(this, rabbotMessage);
      if (handler.length === 2) {
        const context = this.contextFunction
          && await this.contextFunction(this.originalContext, message);
        await handler(context, message);
      } else {
        await handler(message);
      }
    };

    let finalQueueName = queueName;
    const exchangeGroup = this.exchangeGroups[queueName];

    if (exchangeGroup) {
      finalQueueName = exchangeGroup.queue.name;
      if (exchangeGroup.retries) {
        wrappedHandler = async (rabbotMessage) => {
          const message = new WrappedMessage(this, rabbotMessage);
          let context;
          try {
            if (handler.length === 2) {
              context = this.contextFunction
                && await this.contextFunction(this.originalContext, message);
              await handler(context, message);
            } else {
              await handler(message);
            }
          } catch (e) {
            const headers = message.properties.headers || {};
            const retryCount = (headers.retryCount || 0) + 1;
            headers.retryCount = retryCount;
            headers.error = e.message;

            // Error logging
            if (context) {
              const loggingMetadata = context.gb.wrapError(e);
              loggingMetadata.queueName = finalQueueName;
              loggingMetadata.type = message.type;
              loggingMetadata.routingKey = message.fields.routingKey;
              loggingMetadata.retryCount = retryCount;
              context.gb.logger.error('Error handling queue message.', loggingMetadata);
            }

            if (retryCount > exchangeGroup.retries || e.noRetry) {
              message.reject();
            } else {
              const messageOptions = {
                type: message.type,
                body: message.body,
                routingKey: message.fields.routingKey,
                correlationId: message.properties.correlationId,
                timestamp: message.properties.timestamp,
                headers,
              };
              await this.publish(exchangeGroup.retryExchange.name, messageOptions);
              message.ack();
            }
          }
        };
      }
    } else {
      context.gb.logger.error(`SubscriptionFailed: No exchangeGroup found with the name ${queueName}`);
    }

    const handlerThunk = rabbot.handle(type, wrappedHandler, finalQueueName);
    let mq = rabbot.getQueue(finalQueueName);
    if (!mq) {
      // Let's give it a try.
      mq = rabbot.getQueue(`${finalQueueName}.q`);
    }
    assert(mq, `Specified queue (${finalQueueName}) does not exist`);
    mq.subscribe(false);
    this.subs.push([handlerThunk, mq]);
  }

  // eslint-disable-next-line class-methods-use-this
  metadata() {
    return {
      activeMessages: Array.from(WrappedMessage.activeMessages()),
    };
  }

  static async gracefulQueueShutdown(q) {
    if (q?.lastQueue?.messages?.messages?.length) {
      return new Promise((accept) => {
        q.lastQueue.messages
          .on('empty', accept)
          .once();
      });
    }
    // Mostly for tests which restart right away, but rabbot is finicky
    return delay(1000);
  }

  static get activeMessages() {
    return WrappedMessage.activeMessages();
  }
}

export class MockRabbotClient {
  constructor() {
    this.subscriptions = {};
    this.publishMocks = {};
  }

  async internalPublish(exchange, key, body) {
    const mock = (this.publishMocks[exchange] || {})[key];
    if (mock) {
      await mock(exchange, key, body);
    } else {
      this.context.logger.info(`Unmocked messaged published. Exchange: ${exchange} Key: ${key}`);
    }
  }

  async publish(...args) {
    return this.internalPublish(...args);
  }

  async request(...args) {
    return this.internalPublish(...args);
  }

  async bulkPublish(bulk) {
    if (Array.isArray(bulk)) {
      return Promise.all(
        bulk.map(({ type, body, exchange }) => this.internalPublish(exchange, type, body)),
      );
    }
    return Promise.all(
      Object.entries(bulk)
        .map(([exchange, { type, body }]) => this.internalPublish(exchange, type, body)),
    );
  }

  async start(context) {
    this.context = context;
    return this;
  }

  async subscribe(queueName, key, handler) {
    this.subscriptions[queueName] = this.subscriptions[queueName] || {};
    this.subscriptions[queueName][key] = handler;
  }

  resetPublishMocks() {
    this.publishMocks = {};
  }

  async mockPublish(exchange, key, handler) {
    this.publishMocks[exchange] = this.publishMocks[exchange] || {};
    this.publishMocks[exchange][key] = handler;
  }

  async testMessage(context, queueName, key, body, {
    ack = () => { },
    nack = () => { },
    reject = () => { },
  } = {}) {
    const handler = (this.subscriptions[queueName] || {})[key];
    if (!handler) {
      throw new Error(`No handler for key ${key} on queue ${queueName}`);
    } else {
      const message = {
        body,
        ack,
        nack,
        reject,
      };
      if (handler.length === 2) {
        await handler(context, message);
      } else {
        await handler(message);
      }
    }
  }
}
