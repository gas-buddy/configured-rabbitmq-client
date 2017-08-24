import repl from 'repl';
import path from 'path';
import winston from 'winston';
import Client from '../';

const qConfig = require(path.resolve(process.argv[2]));

const context = {
  logger: winston,
};

const mqClient = new Client(context, qConfig);
mqClient
  .start(context).then(() => {
    const rl = repl.start('> ');
    rl.on('exit', () => mqClient.stop());
    rl.context.client = mqClient;

    rl.context.interactive = (queueName, type) => {
      const thunk = mqClient.subscribe(queueName, type, (message) => {
        console.error('GOT A MESSAGE');
      });
      return {
        unsubscribe() {
          mqClient.unsubscribe(thunk);
        },
        publish(message) {
          return mqClient.publish(queueName, type, message);
        },
      };
    };

    rl.context.async = (promise) => promise.then(console.log).catch(console.error);
  })
  .catch(error => winston.error(error));
