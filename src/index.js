import assert from 'assert';
import rabbot from 'rabbot';
import path from 'path';
import _ from 'lodash';
import {
  normalizeExchangeGroups,
  rabbotConfigFromExchangeGroups,
} from './exchangeGroups';
import { WrappedMessage } from './WrappedMessage';

export default class RabbotClient {
  constructor(context, opts) {
    assert(opts, 'configured-rabbitmq-client must be passed arguments');
    assert(opts.username, 'configured-rabbitmq-client missing username setting');
    assert(opts.password, 'configured-rabbitmq-client missing password setting');

    if (context && context.logger && context.logger.info) {
      context.logger.info('Initializing RabbitMQ client', {
        user: opts.username,
        host: opts.hostname || 'rabbitmq',
      });
    }
    const mqConnectionConfig = {
      // In our usage, we've found that a short timeout causes trouble
      // on startup with spurious connection errors just because the box
      // is busy. So we default to a higher initial timeout
      timeout: 15000,
      ...opts.connectionOptions,
      user: opts.username,
      pass: opts.password,
      host: opts.hostname || 'rabbitmq',
      port: opts.port || 5672,
      vhost: opts.basePath || '/',
    };

    // Event handlers need to be cleaned up afterwards...
    this.connSubscription = rabbot.on('connected', () => {
      if (context && context.logger && context.logger.info) {
        context.logger.info('RabbitMQ connection established.');
      }
    });

    this.exchangeGroups = (opts.config && opts.config.exchangeGroups) || {};
    this.exchangeGroups = normalizeExchangeGroups(this.exchangeGroups);
    const exchangeGroupConfig = rabbotConfigFromExchangeGroups(this.exchangeGroups);
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
      finalConfig.logging = {
        adapters: {
          [path.join(__dirname, 'whistlewinston.js')]: {
            ...opts.logging,
            context,
          },
        },
      };
    }

    this.finalConfig = finalConfig;
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

  async start(context) {
    assert(!this.startCalled, 'start called multiple times on configured-rabbitmq-client instance');
    this.startCalled = true;

    const maxRetries = 5;
    for (let retries = maxRetries; retries >= 0; retries -= 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await rabbot.configure(this.finalConfig);
        break;
      } catch (stringError) {
        if (retries) {
          context.logger.warn(`Queue configuration failed, retrying ${retries} more times`, stringError);
          try {
            // eslint-disable-next-line no-await-in-loop
            await rabbot.shutdown();
            rabbot.reset();
          } catch (inner) {
            context.logger.warn('Rabbot cleanup failed', {
              error: inner.message,
              stack: inner.stack,
            });
          }
          // eslint-disable-next-line no-await-in-loop
          await Promise.delay((1 + (maxRetries - retries)) * 2000);
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
        if (context && context.logger && context.logger.error) {
          context.logger.error('RabbitMQ connection was closed.');
        }
      }
    });
    this.unreachSubscription = rabbot.on('unreachable', () => {
      // TODO shutdown the process?
      if (context && context.logger && context.logger.error) {
        context.logger.error('RabbitMQ connection has failed permanently.');
      }
    });
    this.failSubscription = rabbot.onReturned('failed', (e) => {
      if (context && context.logger && context.logger.error) {
        context.logger.error('RabbitMQ connection has failed.', {
          error: e.message,
          stack: e.stack,
        });
      }
    });

    return this;
  }

  async stop(context) {
    assert(this.startCalled, 'stop called multiple times on configured-rabbitmq-client instance');
    if (context && context.logger && context.logger.info) {
      context.logger.info('Closing RabbitMQ connection');
    }
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
    let wrappedHandler = async (rabbotMessage) => {
      const message = new WrappedMessage(rabbotMessage);
      if (handler.length === 2) {
        const context = this.contextFunction &&
          await this.contextFunction(this.originalContext, message);
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
          const message = new WrappedMessage(rabbotMessage);
          let context;
          try {
            if (handler.length === 2) {
              context = this.contextFunction &&
                await this.contextFunction(this.originalContext, message);
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
    }

    const handlerThunk = rabbot.handle(type, wrappedHandler);
    const mq = rabbot.getQueue(finalQueueName);
    mq.subscribe(false);
    this.subs.push([handlerThunk, mq]);
  }

  static async gracefulQueueShutdown(q) {
    if (q &&
      q.lastQueue.messages.messages &&
      q.lastQueue.messages.messages.length) {
      return new Promise((accept) => {
        q.lastQueue.messages
          .on('empty', accept)
          .once();
      });
    }
    // Mostly for tests which restart right away, but rabbot is finicky
    return Promise.delay(1000);
  }

  static get activeMessages() {
    return WrappedMessage.activeMessages();
  }
}
