// Tiny pub/sub bus

const subs = new Map(); // topic -> Set<fn>

export function subscribe(topic, fn) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(fn);
  return () => subs.get(topic)?.delete(fn);
}

export function publish(topic, payload) {
  const set = subs.get(topic);
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try { fn(payload); } catch(e) { console.error(`events: ${topic} handler error`, e); }
  }
}