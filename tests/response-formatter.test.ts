// Compact response formatter tests.
//
// Company search results go through SUMMARY_FIELDS.companies. That allow-list
// used to omit ownerResourceID, so the model could not answer "who owns
// company X?" even though Autotask returned the field.

import { formatCompactResponse, detectEntityType } from '../src/utils/response.formatter';

const OWNER_ID = 29682885;

describe('formatCompactResponse - companies', () => {
  test('keeps ownerResourceID and still drops fields outside the allow-list', () => {
    const { items } = formatCompactResponse(
      [{ id: 1, companyName: 'Acme Corp', ownerResourceID: OWNER_ID, address1: '1 Main St' }],
      'companies',
      {}
    );

    expect(items[0]).toEqual({ id: 1, companyName: 'Acme Corp', ownerResourceID: OWNER_ID });
    expect(items[0]).not.toHaveProperty('address1');
  });

  test.each([null, undefined])('omits ownerResourceID when it is %p', (value) => {
    const { items } = formatCompactResponse(
      [{ id: 1, companyName: 'Acme Corp', ownerResourceID: value }],
      'companies',
      {}
    );

    expect(items[0]).toEqual({ id: 1, companyName: 'Acme Corp' });
  });

  test('inlines _enhanced.ownerResourceName as owner', () => {
    const { items } = formatCompactResponse(
      [{ id: 1, companyName: 'Acme Corp', ownerResourceID: OWNER_ID, _enhanced: { ownerResourceName: 'Jane Doe' } }],
      'companies',
      {}
    );

    expect(items[0].owner).toBe('Jane Doe');
    expect(items[0].ownerResourceID).toBe(OWNER_ID);
  });
});

describe('detectEntityType', () => {
  test('routes autotask_search_companies to the companies allow-list', () => {
    expect(detectEntityType('autotask_search_companies')).toBe('companies');
  });
});
