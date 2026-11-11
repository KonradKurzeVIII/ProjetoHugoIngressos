import { channel } from "node:diagnostics_channel";

export const fifoEvents = channel("api-alta-demanda.fifo");

export interface FifoEvent {
  sequence: number;
  label: string;
  phase: "admitted" | "started" | "finished";
}

/** One process admits operations synchronously; failures never stall the queue. */
export class FifoQueue {
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0;

  run<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const sequence = ++this.sequence;
    const emit = (phase: FifoEvent["phase"]): void => {
      if (fifoEvents.hasSubscribers) {
        fifoEvents.publish({ sequence, label, phase } satisfies FifoEvent);
      }
    };
    emit("admitted");
    const result = this.tail.then(async () => {
      emit("started");
      try {
        return await operation();
      } finally {
        emit("finished");
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async drain(): Promise<void> { await this.tail; }
}
