import type { DB } from "@gerlines/db";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { inTransaction } from "./writer.ts";

function failingFirst(code: string, failures: number): { db: Kysely<DB>; attempts: () => number } {
  let attempts = 0;
  const db = {
    isTransaction: false,
    transaction: () => ({
      execute: async (work: (trx: unknown) => Promise<unknown>) => {
        attempts += 1;
        if (attempts <= failures) throw Object.assign(new Error(code), { code });
        return work({ isTransaction: true });
      },
    }),
  } as unknown as Kysely<DB>;
  return { db, attempts: () => attempts };
}

describe("inTransaction", () => {
  it("runs a transaction that lost a deadlock again", async () => {
    const { db, attempts } = failingFirst("40P01", 1);
    await expect(inTransaction(db, async () => "done")).resolves.toBe("done");
    expect(attempts()).toBe(2);
  });

  it("gives up after three attempts and on any other error at once", async () => {
    const deadlocked = failingFirst("40P01", 5);
    await expect(inTransaction(deadlocked.db, async () => "done")).rejects.toThrow("40P01");
    expect(deadlocked.attempts()).toBe(3);
    const broken = failingFirst("23505", 5);
    await expect(inTransaction(broken.db, async () => "done")).rejects.toThrow("23505");
    expect(broken.attempts()).toBe(1);
  });

  it("joins the caller's transaction without a retry of its own", async () => {
    const trx = { isTransaction: true } as unknown as Kysely<DB>;
    await expect(inTransaction(trx, async (inner) => inner === trx)).resolves.toBe(true);
  });
});
