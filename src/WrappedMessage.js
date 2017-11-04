
const messagesInFlight = new Set();

export class WrappedMessage {
  constructor(message) {
    const { nack, reject, ack, rabbotMessage, ...rest } = message;
    Object.assign(this, rest);
    this.rabbotMessage = message;
    messagesInFlight.add(this);
  }

  async ack() {
    try {
      this.rabbotMessage.ack();
    } catch (error) {
      throw error;
    } finally {
      try { messagesInFlight.delete(this); } catch (_) { /* noop */ }
    }
  }

  async nack() {
    try {
      this.rabbotMessage.nack();
    } catch (error) {
      throw error;
    } finally {
      try { messagesInFlight.delete(this); } catch (_) { /* noop */ }
    }
  }

  async reject() {
    try {
      this.rabbotMessage.reject();
    } catch (error) {
      throw error;
    } finally {
      try { messagesInFlight.delete(this); } catch (_) { /* noop */ }
    }
  }

  static activeMessages() {
    return messagesInFlight;
  }
}
