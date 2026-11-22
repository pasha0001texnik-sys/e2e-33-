import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyQueue } from "./queue.ts";

const item = (scenario_key: string, depends_on: string[] = []) => ({ scenario_key, depends_on });

test("тест ждёт зависимость и стартует после её успеха", () => {
  const q = new DependencyQueue([item("a"), item("b", ["a"]), item("c")]);
  assert.deepEqual(q.next(0), { kind: "run", item: item("a") });
  assert.deepEqual(q.next(1), { kind: "run", item: item("c") }, "независимый тест не ждёт");
  assert.deepEqual(q.next(2), { kind: "wait" }, "b ждёт a");
  q.complete("a", "flaky");
  assert.deepEqual(q.next(1), { kind: "run", item: item("b", ["a"]) }, "flaky считается пройденным");
  assert.deepEqual(q.next(1), { kind: "done" });
});

test("упавшая зависимость пропускает всю цепочку", () => {
  const q = new DependencyQueue([item("a"), item("b", ["a"]), item("c", ["b"])]);
  q.next(0);
  q.complete("a", "failed");
  const s1 = q.next(0);
  assert.equal(s1.kind, "skip");
  assert.match((s1 as { reason: string }).reason, /«a» не прошла/);
  const s2 = q.next(0);
  assert.equal(s2.kind, "skip");
  assert.match((s2 as { reason: string }).reason, /«b» не прошла \(skipped\)/);
  assert.deepEqual(q.next(0), { kind: "done" });
});

test("зависимость, пропущенная до старта, и недостижимые зависимости", () => {
  const q = new DependencyQueue([item("b", ["a"])], [["a", "skipped"]]);
  assert.equal(q.next(0).kind, "skip");
  const q2 = new DependencyQueue([item("b", ["ghost"])]);
  assert.deepEqual(q2.next(1), { kind: "wait" });
  const s = q2.next(0);
  assert.equal(s.kind, "skip");
  assert.match((s as { reason: string }).reason, /недостижимы|не выполнены/);
});

test("при отмене тесты выдаются, чтобы их отметили отменёнными", () => {
  const q = new DependencyQueue([item("a"), item("b", ["a"])]);
  assert.equal(q.next(0, true).kind, "run");
  assert.equal(q.next(0, true).kind, "run");
  assert.deepEqual(q.next(0, true), { kind: "done" });
});
