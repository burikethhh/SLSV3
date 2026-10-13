// Keyset pagination avoids the PostgREST default row limit and offset skips.
// A safety bound is an error, never a supposedly complete truncated snapshot.
export async function readSnapshot<T extends { id: string }>(
  page: (after: string | null, size: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  maximum = 50000,
): Promise<T[]> {
  const result: T[] = [];
  let after: string | null = null;
  while (true) {
    const { data, error } = await page(after, 500);
    if (error || !Array.isArray(data)) throw new Error("Snapshot query unavailable");
    if (!data.length) return result;
    const next = data[data.length - 1].id;
    if (!next || (after !== null && next <= after)) throw new Error("Snapshot cursor did not advance");
    result.push(...data);
    if (result.length > maximum) throw new Error("Snapshot exceeds reviewed facility size");
    after = next;
    if (data.length < 500) return result;
  }
}
