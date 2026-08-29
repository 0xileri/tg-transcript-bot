import { test } from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../src/scheduler.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const drain = async (s) => { while (s.active || s.waiting) await tick(); };

test("never exceeds the concurrency cap", async () => {
  const s = createScheduler({ maxConcurrent: 3, maxPerUser: 99 });
  const ran = [];
  let peak = 0, cur = 0;
  for (let i = 0; i < 12; i++) {
    s.submit(`u${i}`, async () => { peak = Math.max(peak, ++cur); ran.push(i); await tick(10); cur--; });
  }
  await drain(s);
  assert.equal(ran.length, 12, "every job ran");
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the cap of 3`);
});

test("a lone user still gets the full concurrency budget", async () => {
  // Fairness must not mean leaving slots idle on the chance someone shows up later.
  const s = createScheduler({ maxConcurrent: 3, maxPerUser: 99 });
  let peak = 0, cur = 0;
  for (let i = 0; i < 6; i++) {
    s.submit("solo", async () => { peak = Math.max(peak, ++cur); await tick(10); cur--; });
  }
  await drain(s);
  assert.equal(peak, 3, "idle slots went unused while one user had work waiting");
});

test("the next freed slot goes to a waiting newcomer", async () => {
  const s = createScheduler({ maxConcurrent: 2, maxPerUser: 99 });
  const order = [];
  for (let i = 0; i < 5; i++) s.submit("hog", async () => { order.push("hog"); await tick(10); });
  s.submit("other", async () => { order.push("other"); await tick(10); });
  await drain(s);

  // The two hog jobs already in flight when the newcomer arrived cannot be evicted,
  // so the guarantee is that it takes the next slot to free -- position 2, not 5.
  assert.equal(order.indexOf("other"), 2, `newcomer ran at ${order.indexOf("other")}, not the next freed slot`);
  assert.equal(order.length, 6);
});

test("two newcomers are served before a hog's backlog drains", async () => {
  const s = createScheduler({ maxConcurrent: 2, maxPerUser: 99 });
  const order = [];
  for (let i = 0; i < 4; i++) s.submit("hog", async () => { order.push("hog"); await tick(10); });
  s.submit("a", async () => { order.push("a"); await tick(10); });
  s.submit("b", async () => { order.push("b"); await tick(10); });
  await drain(s);

  const lastHog = order.lastIndexOf("hog");
  assert.ok(order.indexOf("a") < lastHog, "user a waited behind the entire backlog");
  assert.ok(order.indexOf("b") < lastHog, "user b waited behind the entire backlog");
});

test("a throwing job frees its slot", async () => {
  const s = createScheduler({ maxConcurrent: 1, maxPerUser: 99 });
  let ran = false;
  s.submit("x", async () => { throw new Error("boom"); });
  s.submit("y", async () => { ran = true; });
  await drain(s);
  assert.ok(ran, "the queue wedged after a job threw");
  assert.equal(s.active, 0);
});

test("counters return to zero and per-user accounting clears", async () => {
  const s = createScheduler({ maxConcurrent: 2, maxPerUser: 2 });
  s.submit("u", async () => { await tick(5); });
  s.submit("u", async () => { await tick(5); });
  assert.ok(s.outstandingFor("u") > 0, "outstanding work is invisible while queued");

  await drain(s);
  assert.equal(s.active, 0);
  assert.equal(s.waiting, 0);
  assert.equal(s.outstandingFor("u"), 0, "per-user count leaked after drain");
  assert.equal(s.hasRunning("u"), false);
});

test("submit reports whether the job actually started", async () => {
  const s = createScheduler({ maxConcurrent: 1, maxPerUser: 99 });
  const first = s.submit("a", async () => { await tick(10); });
  const second = s.submit("b", async () => { await tick(10); });

  assert.equal(first, true, "first job had a free slot and should have started");
  assert.equal(second, false, "second job had no free slot and should have queued");
  await drain(s);

  // A lone job for a busy user still starts via the FIFO fallback when a slot is
  // free -- the case that produced a false "queued" notice in production.
  const s2 = createScheduler({ maxConcurrent: 2, maxPerUser: 99 });
  s2.submit("u", async () => { await tick(10); });
  assert.equal(s2.submit("u", async () => { await tick(10); }), true,
    "same user's second job should use the idle slot, not report as queued");
  await drain(s2);
});
