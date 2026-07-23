/**
 * Maps over `items`, running at most `limit` calls at a time and preserving the
 * input order in the returned array. Used to fan out per-item lookups (e.g.
 * resolving a friends list to profiles) without firing hundreds of parallel
 * requests at the PSN API, which invites throttling.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error("Concurrency limit must be at least 1.");

  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
