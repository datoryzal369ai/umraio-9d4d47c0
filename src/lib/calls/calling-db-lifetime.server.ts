import type { CallingDb } from "./caller-turn-ledger.server";
import { withinCallingBudget } from "./calling-lifetime.server";

/** Calling-local ownership for the existing lazy PostgREST builders. */
export function boundedCallingDb(db: CallingDb, owner: AbortSignal): CallingDb {
  const wrap = (query: any): any => new Proxy(query, { // eslint-disable-line @typescript-eslint/no-explicit-any
    get(target, key) {
      if (key === "then") return (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
        withinCallingBudget(owner, 2500, signal => {
          if (typeof target.abortSignal !== "function") throw new Error("calling_database_cancellation_unavailable");
          return Promise.resolve(target.abortSignal(signal));
        }).then(resolve, reject);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? (...args: unknown[]) => wrap(value.apply(target, args)) : value;
    },
  });
  return { from: table => wrap(db.from(table)), rpc: (name, args) => wrap(db.rpc(name, args)) };
}
