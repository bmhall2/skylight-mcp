/**
 * Quick smoke test — runs against the real Skylight API.
 * Usage: npx tsx scripts/test-calendar.ts
 * Requires SKYLIGHT_EMAIL, SKYLIGHT_PASSWORD, SKYLIGHT_FRAME_ID in env (or .env file).
 */
import { getCalendarEvents } from "../src/api/endpoints/calendar.js";

const today = new Date().toISOString().split("T")[0];

console.log(`Fetching calendar events for ${today}...\n`);

const { events, categories } = await getCalendarEvents({
  dateMin: today,
  dateMax: today,
});

console.log(`Categories in included (${categories.length}):`);
for (const c of categories) {
  console.log(`  [${c.id}] ${c.attributes.label}`);
}

console.log(`\nEvents (${events.length}):`);
for (const event of events) {
  const attrs = event.attributes as Record<string, unknown>;
  const categoryMap = new Map(categories.map((c) => [c.id, c.attributes.label ?? c.id]));
  const categoryRef = event.relationships?.category?.data;
  const assignedTo = categoryRef ? (categoryMap.get(categoryRef.id) ?? categoryRef.id) : null;

  console.log(`  [${event.id}] ${attrs.summary}`);
  console.log(`    starts_at: ${attrs.starts_at}`);
  if (assignedTo) console.log(`    assigned_to: ${assignedTo}`);
}
