/**
 * Channel names by id, looked up once and remembered (routes match channels by name). When the IM can't say
 * (no permission, a network error), the id stands in and the next message asks again.
 */
export function channelNames(lookup: (id: string) => Promise<string | undefined>): (id: string) => Promise<string> {
  const known = new Map<string, string>();
  return async (id) => {
    const cached = known.get(id);
    if (cached) return cached;
    try {
      const name = (await lookup(id)) || id;
      known.set(id, name);
      return name;
    } catch {
      return id;
    }
  };
}
