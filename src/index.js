import assert from 'assert';
import rabbot from 'rabbot';

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

    const finalConfig = Object.assign({}, opts.config);
    finalConfig.connection = Object.assign({}, finalConfig.connection, mqConnectionConfig);
    this.promise = rabbot.configure(finalConfig);
    this.subs = [];
    this.client = rabbot;
  }

  publish(...args) {
    return rabbot.publish(...args);
  }

  request(...args) {
    return rabbot.request(...args);
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
    const handlerThunk = rabbot.handle(type, handler);
    const mq = rabbot.getQueue(queueName);
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
