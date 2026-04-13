import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures this variable is available inside the vi.mock factory below
const mockGet = vi.hoisted(() => vi.fn());

vi.mock("../src/api/client.js", () => ({
  getClient: () => ({
    get: mockGet,
    timezone: "America/New_York",
  }),
}));

import { getCalendarEvents } from "../src/api/endpoints/calendar.js";

beforeEach(() => {
  mockGet.mockReset();
});

describe("getCalendarEvents", () => {
  it("returns events and extracts categories from included", async () => {
    mockGet.mockResolvedValue({
      data: [
        {
          type: "calendar_event",
          id: "evt-1",
          attributes: { summary: "Soccer Practice", starts_at: "2026-04-12T10:00:00-05:00" },
          relationships: {
            category: { data: { type: "category", id: "cat-1" } },
          },
        },
      ],
      included: [
        {
          type: "category",
          id: "cat-1",
          attributes: { label: "Henry", color: "#ff0000", selected_for_chore_chart: true, linked_to_profile: true, profile_pic_url: null },
        },
        {
          // source_calendar items in included should be filtered out
          type: "source_calendar",
          id: "src-1",
          attributes: {},
        },
      ],
    });

    const result = await getCalendarEvents({ dateMin: "2026-04-12", dateMax: "2026-04-12" });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("evt-1");

    // Only category resources — source_calendar should be excluded
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].id).toBe("cat-1");
    expect(result.categories[0].attributes.label).toBe("Henry");
  });

  it("returns empty categories when included is absent", async () => {
    mockGet.mockResolvedValue({
      data: [
        {
          type: "calendar_event",
          id: "evt-2",
          attributes: { summary: "All Hands" },
          relationships: { category: { data: null } },
        },
      ],
      // no included field
    });

    const result = await getCalendarEvents({ dateMin: "2026-04-12", dateMax: "2026-04-12" });

    expect(result.categories).toHaveLength(0);
  });

  it("returns empty categories when included has no category resources", async () => {
    mockGet.mockResolvedValue({
      data: [],
      included: [{ type: "source_calendar", id: "src-1", attributes: {} }],
    });

    const result = await getCalendarEvents({ dateMin: "2026-04-12", dateMax: "2026-04-12" });

    expect(result.categories).toHaveLength(0);
  });

  it("adds 1 day to dateMax when calling the API", async () => {
    mockGet.mockResolvedValue({ data: [], included: [] });

    await getCalendarEvents({ dateMin: "2026-04-12", dateMax: "2026-04-12" });

    expect(mockGet).toHaveBeenCalledWith(
      "/api/frames/{frameId}/calendar_events",
      expect.objectContaining({ date_max: "2026-04-13" })
    );
  });
});

describe("assigned_to formatting", () => {
  it("resolves category IDs to names", async () => {
    mockGet.mockResolvedValue({
      data: [
        {
          type: "calendar_event",
          id: "evt-3",
          attributes: { summary: "Family Dinner" },
          relationships: {
            category: { data: { type: "category", id: "cat-1" } },
          },
        },
      ],
      included: [
        { type: "category", id: "cat-1", attributes: { label: "Ben", color: null, selected_for_chore_chart: false, linked_to_profile: true, profile_pic_url: null } },
        { type: "category", id: "cat-2", attributes: { label: "Henry", color: null, selected_for_chore_chart: false, linked_to_profile: true, profile_pic_url: null } },
      ],
    });

    const { events, categories } = await getCalendarEvents({ dateMin: "2026-04-12", dateMax: "2026-04-12" });

    // Replicate the formatter logic from the tool
    const categoryMap = new Map(categories.map((c) => [c.id, c.attributes.label ?? "Unknown"]));
    const event = events[0];
    const categoryRef = event.relationships?.category?.data;
    const name = categoryRef ? (categoryMap.get(categoryRef.id) ?? categoryRef.id) : null;

    expect(name).toBe("Ben");
  });

  it("falls back to raw ID when a category is missing from included", async () => {
    mockGet.mockResolvedValue({
      data: [
        {
          type: "calendar_event",
          id: "evt-4",
          attributes: { summary: "Mystery Event" },
          relationships: {
            category: { data: { type: "category", id: "cat-99" } },
          },
        },
      ],
      included: [], // cat-99 not in included
    });

    const { events, categories } = await getCalendarEvents({ dateMin: "2026-04-12", dateMax: "2026-04-12" });

    const categoryMap = new Map(categories.map((c) => [c.id, c.attributes.label ?? "Unknown"]));
    const event = events[0];
    const categoryRef = event.relationships?.category?.data;
    const name = categoryRef ? (categoryMap.get(categoryRef.id) ?? categoryRef.id) : null;

    // Falls back to the raw ID when not in included
    expect(name).toBe("cat-99");
  });

  it("produces no assigned_to line when event has no category relationships", async () => {
    mockGet.mockResolvedValue({
      data: [
        {
          type: "calendar_event",
          id: "evt-5",
          attributes: { summary: "Unassigned Event" },
          // no relationships
        },
      ],
      included: [],
    });

    const { events } = await getCalendarEvents({ dateMin: "2026-04-12", dateMax: "2026-04-12" });

    const event = events[0];
    const categoryRef = event.relationships?.category?.data;

    expect(categoryRef).toBeUndefined();
  });
});
