# Patient Experience workflow — verification checklist

Branch: feature/patient-experience-workflow

## Scope
- Only patient-experience/index.html and patient-experience/workflow.js modified.
- No changes to main or opd-smart-guide.
- Local-only mock data. No patient-identifiable information.

## Manual acceptance tests (NOT YET EXECUTED)
1. Load an existing browser with opd_px_demo_v1 records; verify migration preserves record IDs and data.
2. Add case, assign owner, start processing, transfer, escalate, add note, close, reopen.
3. Confirm closure requires an assigned owner and written resolution.
4. Verify event log records actor, timestamp, event, and note.
5. Verify overdue counts, closure rate, average processing time and SLA percentage.
6. Search/filter cases and export CSV; open CSV in Excel.
7. Export JSON, reset and import a valid backup; reject malformed backups.
8. Verify settings edit preserves newline-separated departments/categories/roles.
9. Verify existing NCR, compliance, survey and employee CRUD still works.
10. Verify mobile RTL layout, browser reload persistence and no console errors.
11. Verify only approved files changed; review PR diff before merge.
12. Do not merge or publish until owner approves.

## Known limitations
- No authentication or true role enforcement; closedBy is a demo employee selection.
- No cross-device sync, server audit integrity, attachments or notifications.
- Browser-only data can be cleared by the user.
- The feature branch is not a live deployment; GitHub Pages on main is unchanged.
- Full end-to-end browser tests remain required.
