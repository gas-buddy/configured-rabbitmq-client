import tap from 'tap';
import net from 'net';
import winston from 'winston';
import RabbotClient from '../src/index';

const mqConfig = {
  host: process.env.RABBIT_HOST || 'rabbitmq',
  port: process.env.RABBIT_PORT || 5672,
  username: process.env.RABBIT_USER || 'guest',
  password: process.env.RABBIT_PASSWORD || 'guest',
};

tap.test('wait for rabbit', async (t) => {
  for (let i = 0; i < 10; i += 1) {
    let connected = false;
    await new Promise((accept) => {
      const s = new net.Socket();
      s.once('error', () => {
        t.ok(true, `Waiting for RabbitMQ response from ${mqConfig.host}:${mqConfig.port}`);
        setTimeout(accept, 2500);
      });
      s.connect(mqConfig, () => {
        connected = true;
        accept();
      });
    });
    if (connected) {
      t.ok(true, 'RabbitMQ found');
      return;
    }
  }
  t.fail('Could not connect to RabbitMQ');
});

tap.test('test_connection', async (t) => {
  const mq = new RabbotClient(winston, mqConfig);
  const client = await mq.start();
  t.ok(client.publish, 'Should have a publish method');
  await mq.stop();
  t.ok(true, 'Should shut down');
});
