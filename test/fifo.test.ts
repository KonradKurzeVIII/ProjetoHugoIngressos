import assert from "node:assert/strict";
import { test } from "node:test";
import { FifoQueue } from "../src/fifo.js";

test("FIFO preserves admission order, has one active task and survives rejection", async () => {
  const queue = new FifoQueue();
  const started: number[] = [];
  const finished: number[] = [];
  let active = 0;
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) =>
    queue.run(String(index), async () => {
      assert.equal(++active, 1);
      started.push(index);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (index === 35) throw new Error("Expected failure");
        return index;
      } finally {
        finished.push(index);
        active--;
      }
    }),
  ));
  await queue.drain();
  assert.deepEqual(started, Array.from({ length: 100 }, (_, index) => index));
  assert.deepEqual(finished, started);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(await queue.run("after-failure", async () => 101), 101);
});
