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
    this.promise = rabbot.configure(Object.assign({}, opts.config, mqConnectionConfig));
  }

  async start(context) {
    assert(this.promise, 'start called multiple times on configured-rabbitmq-client instance');
    const promise = this.promise;
    delete this.promise;
    await promise;

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
    return rabbot;
  }

  async stop(context) {
    assert(!this.promise, 'stop called multiple times on configured-rabbitmq-client instance');
    if (context && context.logger && context.logger.info) {
      context.logger.info('Closing RabbitMQ connection');
    }
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
}
