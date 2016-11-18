import tap from 'tap';
import winston from 'winston';
import RabbotClient from '../src/index';

tap.test('test_connection', async (t) => {
  const config = {
    hostname: process.env.RABBIT_HOST || 'rabbitmq',
    port: process.env.RABBIT_PORT,
    username: process.env.RABBIT_USER || 'guest',
    password: process.env.RABBIT_PASSWORD || 'guest',
  };
  const mq = new RabbotClient(winston, config);
  const client = await mq.start();
  t.ok(client.publish, 'Should have a publish method');
  await mq.stop();
  t.ok(true, 'Should shut down');
});
