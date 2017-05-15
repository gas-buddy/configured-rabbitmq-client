import assert from 'assert';
import rabbot from 'rabbot';
import { normalizeExchangeGroups,
         rabbotConfigFromExchangeGroups } from './exchangeGroups';

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

    this.exchangeGroups = normalizeExchangeGroups(opts.exchangeGroups || {});
    const exchangeGroupConfig = rabbotConfigFromExchangeGroups(this.exchangeGroups);
    const finalConfig = Object.assign({}, opts.config);
    finalConfig.exchanges = (finalConfig.exchanges || []).concat(exchangeGroupConfig.exchanges);
    finalConfig.queues = (finalConfig.queues || []).concat(exchangeGroupConfig.queues);
    finalConfig.bindings = (finalConfig.bindings || []).concat(exchangeGroupConfig.bindings);
    finalConfig.connection = Object.assign({}, finalConfig.connection, mqConnectionConfig);
    this.promise = rabbot.configure(finalConfig);
    this.subs = [];
    this.client = rabbot;
  }

  publish(...args) {
    return this.client.publish(...args);
  }

  request(...args) {
    return this.client.request(...args);
  }

  async start(context) {
    assert(this.promise, 'start called multiple times on configured-rabbitmq-client instance');
    const promise = this.promise;
    delete this.promise;
    try {
      await promise;
    } catch (stringError) {
      if (typeof stringError === 'string') {
        throw new Error(stringError);
      }
      throw stringError;
    }

    rabbot.nackUnhandled();
    rabbot.nackOnError();

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
        context.logger.error('RabbitMQ connection has failed.');
      }
    });
    return this;
  }

  async stop(context) {
    assert(!this.promise, 'stop called multiple times on configured-rabbitmq-client instance');
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
  }

  async subscribe(queueName, type, handler) {
    let wrappedHandler = handler;
    let finalQueueName = queueName;
    const exchangeGroup = this.exchangeGroups[queueName];

    if (exchangeGroup) {
      finalQueueName = exchangeGroup.queue.name;
      if (exchangeGroup.retries) {
        wrappedHandler = async (message) => {
          try {
            await handler(message);
          } catch (e) {
            const headers = message.properties.headers || {};
            const retryCount = (headers.retryCount || 0) + 1;
            headers.retryCount = retryCount;
            if (retryCount > exchangeGroup.retries) {
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
}
