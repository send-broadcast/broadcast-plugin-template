// My plugin: runs when Broadcast publishes an event listed in manifest.json hooks.events.
export default definePlugin({
  async onEvent(event, ctx) {
    // Delivery is at least once: skip an event this plugin has already handled.
    const seenKey = `seen:${event.id}`;
    if (await ctx.store.get(seenKey)) return { skipped: true };

    ctx.log.info(`received ${event.type}`);
    // ... your work here (never log personal data) ...

    await ctx.store.set(seenKey, true);
    return { ok: true };
  },
});
