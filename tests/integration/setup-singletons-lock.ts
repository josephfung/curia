// tests/integration/setup-singletons-lock.ts
//
// `web_thread` and `setup_state` are single-row tables (#2358). Integration files run in
// parallel against one curia_test database, so two suites that rewrite those rows would
// see each other's writes. Each such suite holds this lock for its whole run: a
// session-level advisory lock on its own connection, released when the suite ends.
import pg from 'pg';

// An arbitrary, fixed key: only these suites take it.
const SETUP_SINGLETONS_LOCK_KEY = 2358_0001;

/** Waits for the lock; call the returned function in afterAll to release it. */
export async function lockSetupSingletons(connectionString: string): Promise<() => Promise<void>> {
  const holder = new pg.Client({ connectionString, application_name: 'setup-singletons-lock' });
  await holder.connect();
  await holder.query('SELECT pg_advisory_lock($1)', [SETUP_SINGLETONS_LOCK_KEY]);
  // Ending the session releases the lock, so a failed unlock still frees it.
  return async () => {
    await holder.end();
  };
}
