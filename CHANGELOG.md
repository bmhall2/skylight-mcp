# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is a maintained fork of [TheEagleByte/skylight-mcp](https://github.com/TheEagleByte/skylight-mcp).
Changes below include both upstream history (through v1.1.7) and new work in this fork.

## [1.1.10] - 2026-04-15

### Fixed

- **Authentication**: Updated email/password authentication to match Skylight's current web OAuth flow. The server now follows the browser login sequence (`/oauth/authorize` -> `/auth/session` -> `/oauth/token`) and uses the returned bearer token for API requests. The old `/api/sessions` endpoint is no longer used.

### Changed

- Centralized shared API constants (`SKYLIGHT_BASE_URL`, `SKYLIGHT_WEB_APP_URL`, `SKYLIGHT_API_VERSION`) into `src/api/constants.ts`
- API requests now include `Skylight-Api-Version` and `User-Agent` headers
- Subscription status is now detected via `/api/plus_access` after OAuth login rather than parsed from the login response
- Added automated tests for the OAuth login flow

## [1.1.9] - 2026-04-13

### Fixed

- **Family members**: `get_family_members` now includes the category ID for each member (e.g. `Sami (ID: 7790515)`), enabling AI assistants to assign events, chores, and rewards without asking the user for IDs separately

## [1.1.8] - 2026-04-13

### Fixed

- **Calendar assignments**: `get_calendar_events` now surfaces which family member is assigned to each event (`assigned_to` field). The API returns assignment data in `response.included` as `CategoryResource` objects linked via `relationships.category.data` on each event — this was previously discarded entirely.

### Added

- Unit tests for `getCalendarEvents` covering category extraction, `date_max` adjustment, and `assigned_to` formatting

## [1.1.7] - 2025-12-30

### Fixed

- **Authentication**: Fixed email/password authentication to use correct `Basic base64(userId:token)` format instead of `Bearer token`. The Skylight API requires the user ID and token to be combined and base64-encoded for Basic auth.
- **Calendar Events**: Fixed `get_calendar_events` returning no events when querying a single day. The API treats `date_max` as exclusive, so we now add 1 day to ensure events on the end date are included.

### Changed

- Added debug logging for authentication flow to help troubleshoot login issues
- Added automatic retry on 401 errors for email/password auth (attempts re-login once before failing)

## [1.1.6] - 2025-12-29

- Initial public release
