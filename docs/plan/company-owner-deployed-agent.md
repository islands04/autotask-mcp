# Plan: Deployed agent still can't see a company's `ownerResourceID`

**Date:** 2026-11-17
**Status:** Draft
**Related:** [company-owner-resource-id.md](company-owner-resource-id.md) (the earlier fix, already on `main` as `c28ee33`)

---

## 1. Report

An agent connected to the Dockerized server was asked to *"print all the fields available for a company."* Its answer left out `ownerResourceID`, and it couldn't say who owns the company. The agent said:

> "The company search tool confirms the record exists but does not expose the ownerResourceID field in its output. The knowledge/search tool returned no results for this field on repeated attempts. None of the read-only tools currently available to me surface the raw ownerResourceID value for a company record."

## 2. Findings (verified 2026-11-17)

**The current code already returns the field.** The earlier plan was implemented in `c28ee33`:

| Layer | File | State on `main` |
|---|---|---|
| Query | `src/services/autotask.service.ts:226` `searchCompanies()` | No `IncludeFields`, so the full row comes back |
| Compact allow-list | `src/utils/response.formatter.ts:28` | `companies: [..., 'ownerResourceID']` |
| Name enrichment | `src/handlers/tool.handler.ts:219` `enhanceItems()` | Adds `owner` (resolved resource name) |
| Tool description | `src/handlers/tool.definitions.ts:61` | "Each result includes the account owner: ownerResourceID plus the resolved owner name." |
| Server instructions | `src/mcp/server.ts:620` | Mentions owner (ownerResourceID) |

**The local Docker image includes the fix.** `islands04/autotask-mcp:latest` = `:1.0.2-ownerResourceID-fix` (image `51944ecd53e4`, label `org.opencontainers.image.revision=0aef676`). I ran that image's compiled `dist/handlers/tool.handler.js` with a stubbed Autotask service. It returned:

```text
direct: {"summary":{...},"items":[{"id":99,"companyName":"Acme Corp","isActive":true,"ownerResourceID":29682885,"owner":"Jane Doe"}]}
lazy:   {"message":"Found 1 companies","data":[{"id":99,"companyName":"Acme Corp","isActive":true,"ownerResourceID":29682885,"address1":"1 Main","owner":"Jane Doe"}]}
```

**Conclusion:** if the agent were calling `autotask_search_companies` on this build, it would see `ownerResourceID`. The cause is probably not in this repo's code (§3). There is still one real code gap (§4).

Two other points from the agent's message:

- **"knowledge/search tool"** is not a tool this server exposes. No `autotask_*` tool contains "knowledge". The agent's platform (or another MCP server) is putting its own tools alongside ours, which means the agent may not have used our company tool the way we assume.
- **"print all the fields"** can't be done with today's tool set, even on the fixed build. `autotask_search_companies` (non-lazy) returns only the 7 compact fields. There's no single-company tool that returns the full record (§4).

## 3. Step 1: Rule out deployment (no code changes)

Do these in order and stop when the field shows up.

1. **Check which build the deployed server runs.** `/health` reports the version baked into `package.json`:
   ```bash
   curl -s http://<deployed-host>:8080/health
   # expected: "version":"1.0.2-ownerResourceID-fix"
   ```
   Anything else (for example `2.18.0` or an upstream WYRE-AI version) means the old code is running.
2. **Check the container's image on the deployed host:**
   ```bash
   docker inspect autotask-mcp-server --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
   ```
   The revision should be `0aef676` or later. If it's older, the container was never recreated after the new image was built or pulled:
   ```bash
   docker pull islands04/autotask-mcp:1.0.2-ownerResourceID-fix   # or rebuild
   docker compose up -d --force-recreate autotask-mcp
   ```
   Note: `docker-compose.yml` builds and tags `autotask-mcp:latest` locally, which is a different name from `islands04/autotask-mcp:latest`. Make sure the deployed host runs the image you think it does.
3. **Check where the agent connects.** Confirm the agent's MCP connection URL points at this container and not at an upstream WYRE-AI / hosted autotask-mcp. If a gateway sits in front (`AUTH_MODE=gateway`), confirm it forwards to this container.
4. **Refresh the agent's tool list.** Many hosts cache `tools/list` and tool descriptions for the life of a session or connector. Start a new agent session, or reconnect or reload the connector, so it picks up the new description and server instructions.
5. **Check that the platform allows the tool.** The agent mentioned "the read-only tools currently available to me", so the platform filters tools. `autotask_search_companies` has no `annotations.readOnlyHint` (see §4.4). If the platform only enables tools explicitly marked read-only, it may have hidden or downgraded our company search. Check the platform's tool allow-list.
6. **Test the exact call.** From the agent, ask it to call `autotask_search_companies` with `{"searchTerm": "<company name>"}` and paste the raw tool result. If `ownerResourceID` is in the raw result but missing from the agent's answer, the problem is the agent's prompt or summarization, not the server.

If step 6 shows `ownerResourceID` in the raw result, no fix for the missing field is needed. Section 4 is still worth doing so "print all fields" works.

## 4. Step 2: Code change: add `autotask_get_company` (full record)

This fixes the gap the agent ran into. The model has no way to fetch **all** fields of one company. Search is compacted on purpose to save context. The full record is only available through the `autotask://companies/{id}` resource, and most hosts don't let the model read resources on its own.

**Commit type:** `feat:` (new tool). Branch: `feat/get-company-tool` from `main`.

### 4.1 `src/handlers/tool.definitions.ts`: tool definition

Add it next to `autotask_search_companies` (~line 60):

```ts
{
  name: 'autotask_get_company',
  description: 'Get one company by ID with all of its fields, including the account owner (ownerResourceID plus resolved owner name). Use autotask_search_companies first to find the ID.',
  inputSchema: {
    type: 'object',
    properties: {
      companyID: { type: 'number', description: 'The company ID to retrieve' }
    },
    required: ['companyID']
  },
  annotations: { readOnlyHint: true }
},
```

Use `companyID` (canonical casing per WYREAI-372). `normalizeCompanyIdAlias()` in `callTool()` already accepts `companyId`/`CompanyID` too. **Company id `0` is valid** (the root company, WYRE). Use `!= null` checks, never truthiness.

### 4.2 `src/handlers/tool.definitions.ts`: `TOOL_CATEGORIES`

Add `'autotask_get_company'` to `TOOL_CATEGORIES.companies.tools` (~line 3425). This list is maintained by hand and isn't checked against the definitions (see CLAUDE.md, 2026-08-10). If you skip this, lazy mode's `autotask_list_category_tools` won't show the tool.

### 4.3 `src/handlers/tool.handler.ts`: dispatch entry

Next to `autotask_search_companies` (~line 972):

```ts
['autotask_get_company', async (a) => {
  const id = a.companyID;
  if (typeof id !== 'number') throw new Error('companyID (number) is required');
  const r = await s.getCompany(id);
  return { result: r, message: r ? `Found company ${id}` : `Company ${id} not found` };
}],
```

What you get for free:

- `AutotaskService.getCompany()` already exists (`autotask.service.ts:215`, `GET /Companies/{id}`, full row).
- The tool isn't in `COMPACT_SEARCH_TOOLS`, so the object branch of `callTool()` returns the **full** record, enriched by `enhanceItems()`. That adds `owner`, plus `company` if any id field resolves.
- A `null` result triggers `buildNotFoundMessage()` ("No company found with companyID N").

### 4.4 Optional: mark the company search tool read-only

Add `annotations: { readOnlyHint: true }` to `autotask_search_companies` (and ideally the other search/get tools). This only matters if §3 step 5 shows the platform filters on that hint. If so, do it as a separate sweep PR covering every read tool, not just companies.

### 4.5 `src/mcp/server.ts`: server instructions

In `getServerInstructions()`, near the line-620 paragraph, add one sentence: *"Search results are compact. To see every field of a company, call autotask_get_company with its ID."*

### 4.6 Optional: router

In `routeIntent()` (`tool.handler.ts`), send "all fields / details / full record of company X" to `autotask_get_company` (after resolving the name with `searchCompanies`). Send "who owns company X" to `autotask_search_companies`. Remember the router's entity regexes need `s?` for plurals (CLAUDE.md, 2026-08-10).

## 5. Tests

`tests/company-owner.test.ts` already covers search. Add `tests/get-company.test.ts`, using the same pattern (`new AutotaskService(mockConfig, mockLogger)`, `jest.spyOn(service, 'getCompany')`, and stub `getResourceName`):

| Test | Asserts |
|---|---|
| returns the full record | spy returns `{ id: 99, companyName: 'Acme', ownerResourceID: 29682885, address1: '1 Main', phone: 'x' }` → parsed `data` has **all** of those keys plus `owner: 'Jane Doe'` (proves it isn't compacted) |
| calls `getCompany` with the id | `expect(spy).toHaveBeenCalledWith(99)` |
| id 0 works | `companyID: 0` → `getCompany(0)` is called, no "required" error |
| `companyId` alias | `{ companyId: 99 }` → `getCompany(99)` |
| not found | spy returns `null` → `isError: true`, text contains `No company found` |
| missing id | `{}` → error, and `getCompany` is never called |
| lazy mode | `autotask_execute_tool` with `toolName: 'autotask_get_company'` → same shape |
| category parity | `TOOL_CATEGORIES.companies.tools` contains `autotask_get_company`, and every name in `TOOL_CATEGORIES` exists in `TOOL_DEFINITIONS` (a cheap parity check; see CLAUDE.md) |
| read-only annotation | definition has `annotations.readOnlyHint === true` |

**Precondition:** the local `node_modules` is incomplete right now. `ts-jest` is missing, so `npx jest` fails with *"Preset ts-jest not found"*. Run `npm ci` with GitHub Packages auth for `@wyre-ai` first (the same blocker the earlier plan recorded).

Then run:

```bash
npm run lint && node scripts/lint-destructive-warnings.mjs src && npm test
```

## 6. Release and verify

1. Rebuild the image with a new version tag, for example:
   ```bash
   docker build --build-arg VERSION=1.0.3-get-company --build-arg COMMIT_SHA=$(git rev-parse --short HEAD) -t islands04/autotask-mcp:1.0.3-get-company .
   ```
2. Deploy, then **recreate** the container (§3 step 2) and confirm `/health` shows the new version.
3. Reconnect the agent (§3 step 4).
4. Ask again: *"Print all the fields available for company X"*. The agent should search, call `autotask_get_company`, and list `ownerResourceID` and `owner` among the fields.
5. Add a CHANGELOG entry and update the fork README's differences section to mention the new tool.

## 7. Side note: lazy-mode inconsistency (no action required)

In lazy mode, `autotask_execute_tool` → `autotask_search_companies` returns the **full** rows (the probe output above includes `address1`). That's because `COMPACT_SEARCH_TOOLS.has(name)` checks the meta-tool's name, not the inner `toolName`. The result isn't harmful (owner is still there), but the two modes return different shapes and lazy-mode searches use more context. If this gets fixed, use the inner tool name for the compact check in `callTool()`, and track it separately.
