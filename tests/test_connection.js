import tap from 'tap';
import net from 'net';
import RabbitMQClient from '../src/index';

const mqConfig = {
  hostname: process.env.RABBIT_HOST || 'rabbitmq',
  port: process.env.RABBIT_PORT || 5672,
  username: process.env.RABBIT_USER || 'guest',
  password: process.env.RABBIT_PASSWORD || 'guest',
};

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

tap.test('test_connection', async (t) => {
  const mq = new RabbitMQClient(ctx, mqConfig);
  const client = await mq.start(ctx);
  t.ok(client.publish, 'Should have a publish method');
  await mq.stop(ctx);
  t.ok(true, 'Should shut down');
});

tap.test('test_connection with array hostname', async (t) => {
  const config = { ...mqConfig, hostname: [mqConfig.hostname, mqConfig.hostname] };
  const mq = new RabbitMQClient(ctx, config);
  const client = await mq.start(ctx);
  t.ok(client.publish, 'Should have a publish method');
  await mq.stop(ctx);
  t.ok(true, 'Should shut down');
});
