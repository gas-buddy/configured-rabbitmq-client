import tap from 'tap';
import net from 'net';
import winston from 'winston';
import bluebird from 'bluebird';
import RabbotClient from '../src/index';

global.Promise = bluebird;

const mqConfig = {
  hostname: process.env.RABBIT_HOST || 'rabbitmq',
  port: process.env.RABBIT_PORT || 5672,
  username: process.env.RABBIT_USER || 'guest',
  password: process.env.RABBIT_PASSWORD || 'guest',
  config: {
    exchangeGroups: {
      test: {
        retries: 5,
        retryDelay: 250,
        keys: 'testkey',
      },
    },
  },
};

tap.test('wait for rabbit', async (t) => {
  for (let i = 0; i < 10; i += 1) {
    let connected = false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((accept) => {
      const s = new net.Socket();
      s.once('error', () => {
        if (!connected) {
          t.ok(true, `Waiting for RabbitMQ response from ${mqConfig.hostname}:${mqConfig.port}`);
          setTimeout(accept, 2500);
        }
      });
      s.connect({
        host: mqConfig.hostname,
        port: mqConfig.port,
      }, () => {
        connected = true;
        s.end();
        setTimeout(accept, 2500);
      });
    });
    if (connected) {
      t.ok(true, `RabbitMQ found on ${mqConfig.host}:${mqConfig.port}`);
      return;
    }
  }
  t.fail('Could not connect to RabbitMQ');
});

tap.test('test exchange group retry', async (t) => {
  const retryCount = mqConfig.config.exchangeGroups.test.retries;
  t.plan((retryCount + 1) + retryCount);
  const mq = new RabbotClient(winston, mqConfig);
  await mq.start();
  let counter = 0;
  const errorMessage = 'retry again';

  await new Promise(async (accept) => {
    await mq.subscribe('test', 'testkey',
      async (context, message) => {
        if (counter > 0) {
          t.equal(message.properties.headers.error, errorMessage, 'Previous error message is written to message headers');
        }
        counter += 1;
        t.ok(true, `Recieved messsage for the ${counter} time.`);
        if (counter === retryCount + 1) {
          accept();
        }
        throw new Error(errorMessage);
      });
    await mq.publish('test', 'testkey', {});
  }).then(async () => {
    await mq.stop();
  });
});
