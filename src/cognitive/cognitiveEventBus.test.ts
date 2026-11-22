import assert from "node:assert/strict";
import test from "node:test";
import { CognitiveEventBus } from "./cognitiveEventBus";

test("CognitiveEventBus: pubblicazione, ricezione tipizzata e propagazione correlationId", async () => {
  const bus = new CognitiveEventBus();
  const received: Array<{ id: string; correlationId: string; hopDepth: number; topic: unknown }> = [];

  bus.subscribe<{ topic: string }>("cognitive.analysis.ready", (ev) => {
    received.push({
      id: ev.id,
      correlationId: ev.correlationId,
      hopDepth: ev.hopDepth,
      topic: ev.payload.topic,
    });
  });

  const parent = bus.createEvent({
    id: "evt-root-1",
    type: "cognitive.input.received",
    source: "test_suite",
    correlationId: "corr-xyz-123",
    priority: "normal",
    payload: { input: "ciao" },
  });

  const child = bus.createEvent({
    id: "evt-child-1",
    type: "cognitive.analysis.ready",
    source: "test_suite",
    parentEvent: parent,
    payload: { topic: "planning" },
  });

  const result = await bus.publish(child);

  assert.equal(result.accepted, true);
  assert.equal(result.status, "dispatched");
  assert.equal(result.matchedSubscribers, 1);
  assert.equal(result.deliveredCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    id: "evt-child-1",
    correlationId: "corr-xyz-123",
    hopDepth: 1,
    topic: "planning",
  });
  assert.equal(child.parentEventId, "evt-root-1");
  assert.deepEqual(child.causationChain, ["evt-root-1"]);
});

test("CognitiveEventBus: ordinamento deterministico per priorità (sottoscrittori e coda)", async () => {
  const bus = new CognitiveEventBus();
  const subOrder: string[] = [];

  bus.subscribe("priority.check", () => subOrder.push("low"), { priority: "low" });
  bus.subscribe("priority.check", () => subOrder.push("normal-1"), { priority: "normal" });
  bus.subscribe("priority.check", () => subOrder.push("critical"), { priority: "critical" });
  bus.subscribe("priority.check", () => subOrder.push("high"), { priority: "high" });
  bus.subscribe("priority.check", () => subOrder.push("normal-2"), { priority: "normal" });

  const single = bus.createEvent({
    type: "priority.check",
    source: "test",
    payload: {},
  });
  await bus.publish(single);

  assert.deepEqual(subOrder, ["critical", "high", "normal-1", "normal-2", "low"]);

  const queueOrder: string[] = [];
  bus.subscribe<{ tag: string }>("queued.event", (ev) => queueOrder.push(ev.payload.tag));

  bus.enqueue(
    bus.createEvent({ type: "queued.event", source: "test", priority: "low", payload: { tag: "L" } })
  );
  bus.enqueue(
    bus.createEvent({ type: "queued.event", source: "test", priority: "normal", payload: { tag: "N1" } })
  );
  bus.enqueue(
    bus.createEvent({ type: "queued.event", source: "test", priority: "critical", payload: { tag: "C" } })
  );
  bus.enqueue(
    bus.createEvent({ type: "queued.event", source: "test", priority: "high", payload: { tag: "H" } })
  );
  bus.enqueue(
    bus.createEvent({ type: "queued.event", source: "test", priority: "normal", payload: { tag: "N2" } })
  );

  await bus.flushQueue();
  assert.deepEqual(queueOrder, ["C", "H", "N1", "N2", "L"]);
});

test("CognitiveEventBus: prevenzione duplicati per ID evento", async () => {
  const bus = new CognitiveEventBus();
  let callCount = 0;

  bus.subscribe("dedupe.test", () => {
    callCount += 1;
  });

  const event = bus.createEvent({
    id: "evt-fixed-dedupe",
    type: "dedupe.test",
    source: "test",
    payload: { ok: true },
  });

  const first = await bus.publish(event);
  const second = await bus.publish(event);

  assert.equal(first.accepted, true);
  assert.equal(first.status, "dispatched");
  assert.equal(second.accepted, false);
  assert.equal(second.status, "duplicate_ignored");
  assert.equal(callCount, 1);
});

test("CognitiveEventBus: protezione da loop (hopDepth e causationChain) e limite coda", async () => {
  const bus = new CognitiveEventBus({ maxEventDepth: 2, maxQueueSize: 2 });

  const tooDeep = bus.createEvent({
    id: "evt-deep",
    type: "loop.test",
    source: "test",
    hopDepth: 3,
    payload: {},
  });
  const deepRes = await bus.publish(tooDeep);
  assert.equal(deepRes.accepted, false);
  assert.equal(deepRes.status, "rejected_loop");

  const cyclic = bus.createEvent({
    id: "evt-cycle-1",
    type: "loop.test",
    source: "test",
    hopDepth: 1,
    causationChain: ["evt-root", "evt-cycle-1"],
    payload: {},
  });
  const cycleRes = await bus.publish(cyclic);
  assert.equal(cycleRes.accepted, false);
  assert.equal(cycleRes.status, "rejected_loop");

  assert.equal(
    bus.enqueue(bus.createEvent({ type: "q", source: "test", payload: {} })).status,
    "queued"
  );
  assert.equal(
    bus.enqueue(bus.createEvent({ type: "q", source: "test", payload: {} })).status,
    "queued"
  );
  const overflow = bus.enqueue(bus.createEvent({ type: "q", source: "test", payload: {} }));
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.status, "rejected_queue_limit");
});

test("CognitiveEventBus: isolamento errori dei sottoscrittori senza bloccare gli altri", async () => {
  const bus = new CognitiveEventBus();
  const executed: string[] = [];

  bus.subscribe("error.isolation", () => {
    executed.push("first-ok");
  });
  bus.subscribe("error.isolation", () => {
    throw new Error("Errore sincrono simulato nel subscriber");
  });
  bus.subscribe("error.isolation", async () => {
    throw new Error("Errore asincrono simulato nel subscriber");
  });
  bus.subscribe("error.isolation", () => {
    executed.push("last-ok");
    return "done";
  });

  const res = await bus.publish(
    bus.createEvent({ type: "error.isolation", source: "test", payload: {} })
  );

  assert.equal(res.accepted, true);
  assert.equal(res.matchedSubscribers, 4);
  assert.equal(res.deliveredCount, 2);
  assert.equal(res.failedCount, 2);
  assert.deepEqual(executed, ["first-ok", "last-ok"]);
  assert.equal(res.outcomes[1].status, "error");
  assert.match(res.outcomes[1].error ?? "", /Errore sincrono simulato/);
  assert.equal(res.outcomes[2].status, "error");
  assert.match(res.outcomes[2].error ?? "", /Errore asincrono simulato/);
});

test("CognitiveEventBus: fail-closed su eventi corrotti, unsubscribe e dispose", async () => {
  const bus = new CognitiveEventBus();
  let calls = 0;

  const sub = bus.subscribe("cleanup.test", () => {
    calls += 1;
  });
  assert.equal(bus.getSubscriberCount("cleanup.test"), 1);

  sub.unsubscribe();
  assert.equal(bus.getSubscriberCount("cleanup.test"), 0);

  const malformed = { id: "x", type: "", payload: null } as unknown as ReturnType<
    typeof bus.createEvent
  >;
  const invalidRes = await bus.publish(malformed);
  assert.equal(invalidRes.accepted, false);
  assert.equal(invalidRes.status, "rejected_invalid");

  bus.dispose();
  assert.equal(bus.isDisposed(), true);
  const afterDispose = await bus.publish(
    bus.createEvent({ type: "cleanup.test", source: "test", payload: {} })
  );
  assert.equal(afterDispose.accepted, false);
  assert.equal(afterDispose.status, "disposed");
  assert.equal(calls, 0);
});
