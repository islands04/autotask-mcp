# Plan: Surface `ownerResourceID` (account owner) on Company results

**Status:** Implemented on `fix/company-owner-resource-id`, tests not yet run (dependency install blocked on GitHub Packages auth). Implementation also added `ownerResourceID` to company fixtures this plan didn't list: `autotask-service.test.ts` pagination fixtures, `mapping.test.ts` (lines ~95/186/199/203), and `mapping-tenant-store.test.ts` (lines ~112/157).
**Date:** 2026-11-13
**Branch:** `exploration` (cut a `fix/company-owner-resource-id` branch from `main` before implementing)
**Commit type:** `fix:` (a patch release; this restores data the API already returns)

---

## 1. Problem

Asking the deployed server *"Who owns (is assigned to) company X?"* gives a wrong answer. The model says:

> "The company search result I have access to does not expose a dedicated `ownerResourceID` (account owner) field…"

So it falls back to guessing from opportunity ownership.

## 2. Root cause

This isn't an Autotask API limit. The field is fetched and then **thrown away by our own response formatter**.

| Step | File | Behaviour | `ownerResourceID` present? |
|---|---|---|---|
| 1. Query | [src/services/autotask.service.ts:226](../../src/services/autotask.service.ts) `searchCompanies()` | `POST /Companies/query` with **no** `IncludeFields`, so Autotask returns the full entity | ✅ yes |
| 2. Type | [src/types/autotask.ts:16](../../src/types/autotask.ts) `AutotaskCompany` | Already declares `ownerResourceID?: number` | ✅ yes |
| 3. Format | [src/utils/response.formatter.ts:24-26](../../src/utils/response.formatter.ts) `SUMMARY_FIELDS.companies` | Allow-list is `['id','companyName','isActive','phone','city','state']`. `pickSummaryFields()` keeps **only** these | ❌ **dropped here** |
| 4. Enrich | [src/handlers/tool.handler.ts:189](../../src/handlers/tool.handler.ts) `enhanceItems()` | Resolves names for `companyID`, `assignedResourceID`, `projectLeadResourceID` only | ❌ no owner name |

`autotask_search_companies` is in `COMPACT_SEARCH_TOOLS`, so every company search goes through step 3. The model therefore never sees the owner, and has no tool that returns a single full company record either.

Other paths that return Company objects:

| Path | Through the compact formatter? | Owner visible today? |
|---|---|---|
| `autotask_search_companies` (direct, or via `autotask_execute_tool` in lazy mode) | Yes | ❌ |
| Resource `autotask://companies` / `autotask://companies/{id}` ([resource.handler.ts](../../src/handlers/resource.handler.ts)) | No (raw JSON) | ✅ ID only, no name |
| `autotask_create_company` / `autotask_update_company` | n/a (input) | Already accept `ownerResourceID` ([tool.definitions.ts:122](../../src/handlers/tool.definitions.ts), [:260](../../src/handlers/tool.definitions.ts)) |
| `MappingService` company cache ([mapping.service.ts](../../src/utils/mapping.service.ts)) | n/a (stores id→name only) | Not needed |

## 3. Goal / acceptance criteria

1. Every `autotask_search_companies` result item includes `ownerResourceID` whenever Autotask returns a non-null value.
2. Each such item also carries a resolved, human-readable **`owner`** name (same pattern as `assignedTo` and `lead`). If the name lookup fails, the item still keeps the raw `ownerResourceID`.
3. Lazy-loading mode (`autotask_execute_tool` → `autotask_search_companies`) returns the same shape.
4. The tool description tells the model that company search returns the account owner, so it stops claiming the field is missing.
5. Unit tests cover the formatter, the enrichment, and the end-to-end tool output. Every test fixture that builds a Company object includes `ownerResourceID` (see §5).
6. `npm run lint`, `node scripts/lint-destructive-warnings.mjs src`, `npm run build`, and `npm test` all pass.

**Out of scope:** adding a new `autotask_get_company` tool (see §7, optional follow-up), and changing the `MappingService` cache shape.

## 4. Code changes

### 4.1 `src/utils/response.formatter.ts`: keep the field

Add `ownerResourceID` to the companies allow-list:

```ts
companies: ['id', 'companyName', 'isActive', 'phone', 'city', 'state', 'ownerResourceID'],
```

`pickSummaryFields()` already skips `undefined`/`null` values, so companies without an owner simply omit the key. Resource IDs are never `0`, so the existing null check is enough (unlike `companyID`, see the WYREAI-373 note in CLAUDE.md).

In `pickSummaryFields()`'s `_enhanced` block, also inline `item._enhanced.ownerResourceName` → `compact.owner`, alongside `assignedResourceName`. This keeps the `_enhanced` path consistent if anything populates it.

### 4.2 `src/handlers/tool.handler.ts`: resolve the owner's name

In `enhanceItems()`, add a fourth block next to the `projectLeadResourceID` one:

```ts
if (item.ownerResourceID != null && typeof item.ownerResourceID === 'number') {
  try {
    const name = await mappingService.getResourceName(item.ownerResourceID);
    if (name) result.owner = name;
  } catch { /* skip */ }
}
```

Notes:

- Enrichment runs **after** compaction (`compact.items = await this.enhanceItems(compact.items)`), so 4.1 is required for this to see the field.
- This also enriches any other entity that carries `ownerResourceID` (e.g. opportunities from `autotask_get_opportunity`). That's desirable, but call it out in the PR description.
- **Cost:** at most one extra resource lookup per distinct owner. It's cached by `MappingService` (resources are pre-warmed per tenant) and bounded by `AUTOTASK_ENHANCE_CONCURRENCY`. No new risk of hitting the thread-limit 429.

### 4.3 `src/handlers/tool.definitions.ts`: tell the model

Update the `autotask_search_companies` description, e.g.:

```ts
description: 'Search companies by name or status. Returns the account owner (ownerResourceID, plus resolved owner name). Max 200/page.',
```

Also update the `ownerResourceID` property descriptions on `autotask_create_company` (line ~122, currently blank) to `'Resource ID of the account owner'`, matching update_company.

### 4.4 `src/mcp/server.ts`: server instructions (small)

In `getServerInstructions()`, change the "ID-to-Name Mapping" paragraph to mention owner names:

> "…human-readable names for company, assigned/lead resource, and company owner IDs…"

This line is fed into the model's system prompt, so it directly fights the "field isn't surfaced" claim.

### 4.5 No change needed

- `autotask.service.ts` `searchCompanies()` / `getCompany()` / `listAllCompanies()`: already return full rows. **Don't** add `IncludeFields` here. Restricting fields would turn the formatter into the only safety net and risk the same bug in reverse.
- `types/autotask.ts`: already has `ownerResourceID?: number`. Leave it optional (Autotask can return `null`).
- `resource.handler.ts`: returns raw company JSON, which already includes the field.

## 5. Unit test changes

Per the requirement that **any Company object in tests includes `ownerResourceID`**, there are two groups: (A) new behavioural tests, and (B) fixture updates to existing tests.

Test convention (from CLAUDE.md learnings): assert on the **request sent** and the **exact output shape**, not just "a result came back".

### 5A. New tests

#### `tests/response-formatter.test.ts` (new file, no formatter test exists today)

| Test | Asserts |
|---|---|
| keeps `ownerResourceID` on companies | `formatCompactResponse([{ id: 1, companyName: 'Acme', ownerResourceID: 29682885, address1: 'x' }], 'companies', {})` → item has `ownerResourceID: 29682885` and **no** `address1` (the allow-list still applies) |
| omits `ownerResourceID` when null/undefined | `ownerResourceID: null` → key absent |
| inlines `_enhanced.ownerResourceName` as `owner` | `_enhanced: { ownerResourceName: 'Jane Doe' }` → `owner: 'Jane Doe'` |
| `detectEntityType('autotask_search_companies') === 'companies'` | guards the routing that sends companies through this allow-list |

#### `tests/company-owner.test.ts` (new file, end-to-end through `AutotaskToolHandler.callTool`)

Pattern: `new AutotaskService(mockConfig, mockLogger)` + `jest.spyOn(service, 'searchCompanies')`, the same style as `tests/lazy-loading.test.ts:137`. Stub `MappingService.create` (or `getResourceName`) the way `tests/wyreai-527-ticket-details-and-time-entry-notes.test.ts` does.

| Test | Asserts |
|---|---|
| search_companies returns owner ID and name | spy returns `[{ id: 99, companyName: 'Acme Corp', ownerResourceID: 29682885 }]`; `getResourceName(29682885)` → `'Jane Doe'`; parsed `items[0]` has `ownerResourceID: 29682885`, `owner: 'Jane Doe'` |
| owner name lookup fails | `getResourceName` throws or returns `null` → `ownerResourceID` still present, `owner` absent, `isError` falsy |
| company without owner | `ownerResourceID: null` → neither key present; no `getResourceName` call for it |
| lazy mode parity | `new AutotaskToolHandler(service, logger, true)` + `callTool('autotask_execute_tool', { toolName: 'autotask_search_companies', arguments: { searchTerm: 'Acme' } })` → same `ownerResourceID` + `owner` |
| tool description mentions owner | `TOOL_DEFINITIONS.find(t => t.name === 'autotask_search_companies').description` matches `/owner/i` |

#### `tests/autotask-service.test.ts` (add to the existing `searchCompanies` describe, ~line 824)

| Test | Asserts |
|---|---|
| does not restrict fields | captured request body has **no** `IncludeFields` (guards against a future change re-introducing the bug at the query layer) |
| passes `ownerResourceID` through | mocked API item `{ id: 1, companyName: 'Co', ownerResourceID: 5 }` → returned row has `ownerResourceID: 5` |

### 5B. Existing fixtures to update (add `ownerResourceID`)

These tests build Company objects. Add a realistic `ownerResourceID` (e.g. `29682885`) to each. Where a test checks exact equality on a company, update the expected value too.

| File | Line(s) | Fixture | Change |
|---|---|---|---|
| `tests/autotask-service.test.ts` | ~834 | `Array.from({length:25}, … ({ id, companyName }))` | add `ownerResourceID: 29682885` |
| `tests/basic-autotask-connection.test.ts` | ~48 | `mockCompany` | add field; optionally `expect(mockCompany.ownerResourceID).toBe(…)` |
| `tests/contract-service-lines.test.ts` | ~155, 156, 284, 324, 346, 406 | `getCompany` mocks | add field (no assertion change; `companyName` is what's checked) |
| `tests/intent-router.test.ts` | ~52, 59-60, 68-69, 103 | `searchCompanies` hits | add field. `CompanySearchHit` only declares `id`/`companyName`, so cast or extend the fixture type in the test, **not** the production interface |
| `tests/lazy-loading.test.ts` | ~139, 183 | `searchCompanies` mocks | add field |
| `tests/mapping.test.ts` | ~21-22 | `listAllCompanies` mock | add field (cache stores names only; shows the extra field is harmless) |
| `tests/mapping-tenant-store.test.ts` | ~28-29, 34, 65, 68 | `listAllCompanies` / `getCompany` mocks | add field |
| `tests/zone-401-retry.test.ts` | ~116-124, 202-210 | `{ id: 123, companyName: 'Acme' }` response + `toEqual` | add field to **both** the mocked body and the `toEqual` expectation (and the `get<…>` type argument) |

Checked and **no change needed**:

- `company-id-zero-and-casing.test.ts`: site configurations only, no Company object
- `thread-limit-concurrency.test.ts`: `/Companies` paths with `{ id: 1 }` stubs; these test transport, not entity shape (optional: add the field for consistency)
- `worker.test.ts`: only checks the tool name exists
- `wyreai-527-…test.ts`: only stubs `getCompanyName`

## 6. Implementation steps

1. Branch from `main`: `git switch -c fix/company-owner-resource-id main`
2. Write the new tests in §5A first and confirm they **fail** (red).
3. Apply §4.1 (formatter). The formatter tests and the ID part of the e2e tests pass.
4. Apply §4.2 (enrichment). The `owner` name tests pass.
5. Apply §4.3 and §4.4 (descriptions / instructions). The description test passes.
6. Update fixtures per §5B.
7. Run:
   ```bash
   npm run lint && node scripts/lint-destructive-warnings.mjs src && npm test
   ```
8. Manual check with the Inspector against a real tenant:
   ```bash
   npx @modelcontextprotocol/inspector node dist/entry.js
   ```
   Call `autotask_search_companies { "searchTerm": "<company X>" }` and confirm `ownerResourceID` and `owner` match the Account Owner shown in the Autotask UI.
9. Re-ask the original question in the client: *"Who owns company X?"* The answer should name the account owner directly.
10. Commit `fix: include ownerResourceID and owner name in company search results` and open a PR.

## 7. Optional follow-ups (separate PRs)

- **`autotask_get_company` tool**: there's no single-company tool today (only search plus the `autotask://companies/{id}` resource, which most hosts don't let the model read on its own). A get-by-ID tool returning the full record would stop the formatter from hiding any other company field the model needs later.
- **Router intent**: make `routeIntent()` map "who owns / account owner / account manager of <company>" to `autotask_search_companies` with `searchTerm` = company name. (For *companies*, `searchTerm` **is** a `companyName` `contains` filter, unlike tickets.) Add a case to `tests/intent-router.test.ts`.
- **Allow-list review**: other `SUMMARY_FIELDS` entries may hide similar ownership fields (e.g. `contacts` lacks `title`, `projects` lacks `projectManagerResourceID`-style fields). Audit them against common user questions.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Slightly larger search responses | One number + one short string per row; negligible next to the existing fields |
| Extra API calls for owner names | Served from the per-tenant `MappingService` resource cache; concurrency already capped |
| The new `owner` key collides with an existing field | No Company/Opportunity field named `owner` in `types/autotask.ts`; the e2e test asserts the exact shape |
| Inactive or deleted owner resource | `getResourceName` returns `null` → only the ID is shown (covered by a test) |
