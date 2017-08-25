import repl from 'repl';
import path from 'path';
// eslint-disable-next-line import/no-extraneous-dependencies
import winston from 'winston';
import Client from '../';

// eslint-disable-next-line import/no-dynamic-require
const qConfig = require(path.resolve(process.argv[2]));

const context = {
  logger: winston,
};

class Subscription {
  constructor(name, type, mqClient, thunk) {
    this.thunk = thunk;
    this.name = name;
    this.type = type;
    this.mqClient = mqClient;
    this.messages = [];
  }

  unsubscribe() {
    this.mqClient.unsubscribe(this.thunk);
  }

  publish(message) {
    return this.mqClient.publish(this.name, this.type, message);
  }

  async ack(ix) {
    await this.messages[ix].message.ack();
    this.messages[ix].accept();
    this.messages[ix] = null;
  }

  async nack(ix) {
    await this.messages[ix].message.nack();
    this.messages[ix].accept();
    this.messages[ix] = null;
  }

  async reject(ix) {
    await this.messages[ix].message.reject();
    this.messages[ix].accept();
    this.messages[ix] = null;
  }

  message(ix) {
    return this.messages[ix].message;
  }

  throw(ix, error) {
    this.messages[ix].reject(error);
    this.messages[ix] = null;
  }

  onMessage(message) {
    let ix = this.messages.findIndex(i => !i);
    if (ix === -1) {
      ix = this.messages.length;
    }
    const rz = {
      message,
    };
    this.messages[ix] = rz;
    const promise = new Promise((accept, reject) => {
      rz.accept = accept;
      rz.reject = reject;
    });
    winston.info(`Received message #${ix} on ${this.name}#${this.type}
-----------------------------------------------------------------------------
${JSON.stringify(message, null, '\t')}
-----------------------------------------------------------------------------
`);
    return promise;
  }
}

const mqClient = new Client(context, qConfig);
mqClient.contextFunction = () => ({
  gb: {
    logger: winston,
    wrapError(e) { return e; },
  },
});

mqClient
  .start(context).then(() => {
    const rl = repl.start('> ');
    rl.on('exit', () => mqClient.stop());
    rl.context.client = mqClient;
    rl.context.subs = {};

    rl.context.subscribe = (queueName, type) => {
      let sub;
      const thunk = mqClient.subscribe(queueName, type, (mqctx, message) => sub.onMessage(message));
      sub = new Subscription(queueName, type, mqClient, thunk);
      rl.context.subs[queueName] = rl.context.subs[queueName] || {};
      rl.context.subs[queueName][type] = sub;
      return sub;
    };
    rl.context.async = promise => promise.then(winston.info).catch(winston.error);
  })
  .catch(error => winston.error(error));
