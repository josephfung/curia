// call-budget.ts — how long a tool call has left, for clients that make
// network requests on its behalf (#2083).
//
// The execution layer races each handler against its manifest timeout. Losing
// the race does not stop the handler: it keeps running, and a read-modify-write
// it finishes late can undo a newer call's write. A budget lets a client cancel
// its in-flight request when the call times out, and refuse to wait out a
// Retry-After that ends after the deadline.
//
// ToolContext carries both fields, so a handler can pass `ctx` as the budget.

export interface CallBudget {
  /** Aborted when the tool call times out. */
  signal?: AbortSignal;
  /** Epoch milliseconds at which the tool call times out. */
  deadline?: number;
}

/** Milliseconds left before the deadline. Infinity when the budget has none. */
export function remainingMs(budget: CallBudget | undefined, now = Date.now()): number {
  return budget?.deadline === undefined ? Infinity : budget.deadline - now;
}

/** True once the call has timed out (aborted, or past its deadline). */
export function budgetExpired(budget: CallBudget | undefined): boolean {
  return budget?.signal?.aborted === true || remainingMs(budget) <= 0;
}
