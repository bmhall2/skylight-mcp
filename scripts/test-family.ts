/**
 * Quick smoke test for get_family_members.
 * Usage: npx tsx scripts/test-family.ts
 * Requires SKYLIGHT_EMAIL, SKYLIGHT_PASSWORD, SKYLIGHT_FRAME_ID in env.
 */
import { getFamilyMembers } from "../src/api/endpoints/categories.js";

const members = await getFamilyMembers();

console.log(`Family members (${members.length}):`);
for (const m of members) {
  console.log(`  ${m.attributes.label ?? "Unnamed"} (ID: ${m.id})`);
  if (m.attributes.color) console.log(`    Color: ${m.attributes.color}`);
}
