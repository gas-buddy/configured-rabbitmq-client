import tap from 'tap';
import net from 'net';
import winston from 'winston';
import RabbotClient from '../src/index';
import _ from 'lodash';
import bluebird from 'bluebird';
global.Promise = bluebird;

const mqConfig = {
  hostname: process.env.RABBIT_HOST || 'rabbitmq',
  port: process.env.RABBIT_PORT || 5672,
  username: process.env.RABBIT_USER || 'guest',
  password: process.env.RABBIT_PASSWORD || 'guest',
  shorthandConfigs: [
    {
      exchange: 'test.exchange',
      queue: 'test.queue',
      keys: 'testkey',
    },
    {
      exchange: 'noretry.exchange',
      queue: 'noretry.queue',
      keys: 'noretrykey',
      noRetry: true,
    },
  ],
};

tap.test('wait for rabbit', async (t) => {
  for (let i = 0; i < 10; i += 1) {
    let connected = false;
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

tap.test('test shorthand retry', async (t) => {
  t.plan(5);
  const mq = new RabbotClient(winston, mqConfig);
  const client = await mq.start();
  let counter = 0;
  await new Promise(async (accept, reject) => {
    await mq.subscribe('test.queue', 'testkey',
                       async (message) => {
                         counter++;
                         t.ok(true, `Recieved messsage for the ${counter} time.`);
                         if (counter === 5) {
                           accept();
                         }
                         throw new Error('retry again');
                       });
    console.log('sub');
    await mq.publish('test.exchange', 'testkey', {});// {routingKey: 'testkey'});
  }).then(async () => {
    await mq.stop();
  });
});

tap.test('test shorthand noRetry', async (t) => {
  const mq = new RabbotClient(winston, mqConfig);
  const client = await mq.start();
  let counter = 0;
  await new Promise(async (accept, reject) => {
    await mq.subscribe('noretry.queue', 'noretrykey',
                       async (message) => {
                         counter++;
                         t.ok(counter <= 1, `Recieved messsage for the ${counter} time.`);
                         Promise.delay(1000).then(() => {
                           accept();
                         });
                         throw new Error('nack');
                       });
    await mq.publish('noretry.exchange', 'noretrykey', {});
  }).then(async () => {
    await mq.stop();
  });
});
