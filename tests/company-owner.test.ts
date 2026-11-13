// Company account owner (ownerResourceID) in tool output.
//
// "Who owns company X?" got a wrong answer because autotask_search_companies
// stripped ownerResourceID in compact mode. These tests drive the real
// AutotaskToolHandler.callTool path and assert on the exact output shape.

import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');

const mockConfig: McpServerConfig = {
  name: 'test-server',
  version: '1.0.0',
  autotask: {
    username: 'test-username',
    secret: 'test-secret',
    integrationCode: 'test-integration-code',
  },
};

const OWNER_ID = 29682885;

type ResourceNameFn = (id: number) => Promise<string | null>;

function setup(
  companies: Record<string, unknown>[],
  getResourceName: ResourceNameFn = async (id) => (id === OWNER_ID ? 'Jane Doe' : null),
  lazyLoading = false
) {
  const service = new AutotaskService(mockConfig, logger);
  const search = jest.spyOn(service, 'searchCompanies').mockResolvedValue(companies as any);
  const handler = new AutotaskToolHandler(service, logger, lazyLoading);
  const resourceNameSpy = jest.fn(getResourceName);
  // Offline: no real MappingService cache fill through the Autotask client.
  (handler as any).getMappingService = async () => ({
    getCompanyName: async () => null,
    getResourceName: resourceNameSpy,
  });
  return { handler, search, resourceNameSpy };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('autotask_search_companies account owner', () => {
  test('returns ownerResourceID and the resolved owner name', async () => {
    const { handler, resourceNameSpy } = setup([
      { id: 99, companyName: 'Acme Corp', ownerResourceID: OWNER_ID, isActive: true },
    ]);

    const result = await handler.callTool('autotask_search_companies', { searchTerm: 'Acme' });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items[0]).toEqual({
      id: 99,
      companyName: 'Acme Corp',
      isActive: true,
      ownerResourceID: OWNER_ID,
      owner: 'Jane Doe',
    });
    expect(resourceNameSpy).toHaveBeenCalledWith(OWNER_ID);
  });

  test('keeps ownerResourceID when the owner name lookup throws', async () => {
    const { handler } = setup(
      [{ id: 99, companyName: 'Acme Corp', ownerResourceID: OWNER_ID }],
      async () => { throw new Error('Autotask 500'); }
    );

    const result = await handler.callTool('autotask_search_companies', { searchTerm: 'Acme' });

    expect(result.isError).toBeFalsy();
    const item = JSON.parse(result.content[0].text).items[0];
    expect(item.ownerResourceID).toBe(OWNER_ID);
    expect(item).not.toHaveProperty('owner');
  });

  test('keeps ownerResourceID when the owner name is unknown', async () => {
    const { handler } = setup(
      [{ id: 99, companyName: 'Acme Corp', ownerResourceID: OWNER_ID }],
      async () => null
    );

    const result = await handler.callTool('autotask_search_companies', { searchTerm: 'Acme' });

    const item = JSON.parse(result.content[0].text).items[0];
    expect(item.ownerResourceID).toBe(OWNER_ID);
    expect(item).not.toHaveProperty('owner');
  });

  test('company without an owner has neither key and triggers no lookup', async () => {
    const { handler, resourceNameSpy } = setup([
      { id: 99, companyName: 'Acme Corp', ownerResourceID: null },
    ]);

    const result = await handler.callTool('autotask_search_companies', { searchTerm: 'Acme' });

    const item = JSON.parse(result.content[0].text).items[0];
    expect(item).not.toHaveProperty('ownerResourceID');
    expect(item).not.toHaveProperty('owner');
    expect(resourceNameSpy).not.toHaveBeenCalled();
  });

  test('lazy mode (autotask_execute_tool) returns the same owner fields', async () => {
    const { handler, search } = setup(
      [{ id: 99, companyName: 'Acme Corp', ownerResourceID: OWNER_ID }],
      undefined,
      true
    );

    const result = await handler.callTool('autotask_execute_tool', {
      toolName: 'autotask_search_companies',
      arguments: { searchTerm: 'Acme' },
    });

    expect(result.isError).toBeFalsy();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ searchTerm: 'Acme' }));
    // execute_tool is not a compact search tool, so rows come back under data.
    const item = JSON.parse(result.content[0].text).data[0];
    expect(item.ownerResourceID).toBe(OWNER_ID);
    expect(item.owner).toBe('Jane Doe');
  });

  test('tool description tells the model the owner is returned', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'autotask_search_companies');
    expect(tool?.description).toMatch(/ownerResourceID/);
    expect(tool?.description).toMatch(/owner/i);
  });
});
