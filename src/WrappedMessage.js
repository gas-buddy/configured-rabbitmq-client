
const messagesInFlight = new Set();

const CALL_INFO = Symbol('Call Info');
const CLIENT_INFO = Symbol('RabbitMQ Client');

function messageComplete(wrapped, eventName) {
  try { messagesInFlight.delete(wrapped); } catch (_) { /* noop */ }
  if (wrapped[CLIENT_INFO].listenerCount(eventName)) {
    wrapped[CLIENT_INFO].emit(eventName, wrapped[CALL_INFO]);
  }
  wrapped[CLIENT_INFO].emit('count', messagesInFlight.size);
}

export class WrappedMessage {
  constructor(client, message) {
    const { nack, reject, ack, rabbitMessage, ...rest } = message;
    Object.assign(this, rest);
    this.arrivalTime = Date.now();
    this.rabbitMessage = message;
    messagesInFlight.add(this);
    this[CLIENT_INFO] = client;
    this[CALL_INFO] = {
      operationName: 'handleQueueMessage',
      message,
    };
    client.emit('start', this[CALL_INFO]);
    client.emit('count', messagesInFlight.size);
  }

  async ack() {
    try {
      await this.rabbitMessage.ack();
    } catch (error) {
      throw error;
    } finally {
      messageComplete(this, 'finish');
    }
  }

  async nack() {
    try {
      await this.rabbitMessage.nack();
    } catch (error) {
      throw error;
    } finally {
      messageComplete(this, 'error');
    }
  }

  async reject() {
    try {
      await this.rabbitMessage.reject();
    } catch (error) {
      throw error;
    } finally {
      messageComplete(this, 'error');
    }
  }

  static activeMessages() {
    return messagesInFlight;
  }
}
