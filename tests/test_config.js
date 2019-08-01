import tap from 'tap';
import net from 'net';
import bluebird from 'bluebird';
import RabbotClient from '../src/index';

const mqConfig = {
  hostname: process.env.RABBIT_HOST || 'rabbitmq',
  port: process.env.RABBIT_PORT || 5672,
  username: process.env.RABBIT_USER || 'guest',
  password: process.env.RABBIT_PASSWORD || 'guest',
  logging: {
    level: 2,
  },
};

function configWithExchangeGroups(exchangeGroups) {
  return {
    ...mqConfig,
    config: {
      exchangeGroups,
    },
  };
}

const ctx = { logger: console };

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
  const retryCount = 5;
  t.plan((retryCount + 3) + retryCount);
  const mq = new RabbotClient(ctx, configWithExchangeGroups({
    test: {
      retries: retryCount,
      retryDelay: 250,
      keys: 'testkey',
    },
  }));
  await mq.start(ctx);
  let counter = 0;
  const errorMessage = 'retry again';

  await new Promise(async (accept) => {
    await mq.subscribe('test', 'testkey',
      async (context, message) => {
        if (counter > 0) {
          t.equal(message.properties.headers.error, errorMessage, 'Previous error message is written to message headers');
        } else {
          t.equal(RabbotClient.activeMessages.size, 1, 'Should have 1 active message');
        }
        counter += 1;
        t.ok(true, `Recieved messsage for the ${counter} time.`);
        if (counter === retryCount + 1) {
          await message.ack();
          accept();
        }
        throw new Error(errorMessage);
      });
    await mq.publish('test', 'testkey', {});
  }).then(async () => {
    t.equal(RabbotClient.activeMessages.size, 0, 'Should have 0 active message');
    await mq.stop(ctx);
  });
});

tap.test('test routing key reuse', async (t) => {
  const mq = new RabbotClient(ctx, configWithExchangeGroups({
    one: {
      keys: 'number',
    },
    two: {
      keys: 'number',
    },
  }));

  await mq.start(ctx);
  let receivedOne = 0;
  let receivedTwo = 0;

  await (async () => {
    await mq.subscribe('one', 'number', async (context, message) => {
      receivedOne += 1;
      await message.ack();
    });

    await mq.subscribe('two', 'number', async (context, message) => {
      receivedTwo += 1;
      await message.ack();
    });

    await mq.publish('one', 'number', {});
    await mq.publish('two', 'number', {});
    await mq.publish('two', 'number', {});
    await bluebird.delay(250);
  })();

  t.strictEqual(receivedOne, 1, 'Should have received exactly one message on the one handler.');
  t.strictEqual(receivedTwo, 2, 'Should have received exactly two messages on the two handler.');
  await mq.stop(ctx);
});

tap.test('test delivery_mode pass thru', async (t) => {
  const retryCount = 2;
  const mq = new RabbotClient(ctx, configWithExchangeGroups({
    persistent: {
      retries: retryCount,
      retryDelay: 100,
      persistent: true,
      keys: 'one',
    },
  }));
  await mq.start(ctx);
  await new Promise(async (accept) => {
    await mq.subscribe('persistent', 'one',
      async (context, message) => {
        if (!message.properties.headers.retryCount) {
          t.strictEqual(message.properties.deliveryMode, 2, 'Persistent message should have deliveryMode=2');
        } else {
          t.strictEqual(message.properties.deliveryMode, 2, 'Persistent message retries should retain deliveryMode=2');
        }
        throw new Error('error');
      });

    await mq.subscribe('persistent.rejected.q', 'one',
      async (context, message) => {
        t.strictEqual(message.properties.deliveryMode, 2, 'Rejected persistent message should retain deliveryMode=2');
        message.ack();
        accept();
      });
    await mq.publish('persistent', 'one', {});
  });
  t.equal(RabbotClient.activeMessages.size, 0, 'Should have 0 active message');
  await mq.stop(ctx);
});
