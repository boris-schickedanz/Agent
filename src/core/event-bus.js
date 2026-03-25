import { EventEmitter } from 'events';

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  emitAsync(event, ...args) {
    return Promise.all(
      this.listeners(event).map(listener =>
        Promise.resolve(listener(...args)).catch(err => {
          this.emit('error', err);
        })
      )
    );
  }
}
