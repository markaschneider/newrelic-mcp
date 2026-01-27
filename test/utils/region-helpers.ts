/**
 * Test utilities for region-specific testing
 */

/**
 * Returns the region subdomain ('.eu' or '') based on NEW_RELIC_REGION env var
 * Used for constructing region-aware API URLs in tests
 */
export function getRegionSubdomain(): string {
  return process.env.NEW_RELIC_REGION?.toUpperCase() === 'EU' ? '.eu' : '';
}

/**
 * Returns the test region ('US' | 'EU') based on NEW_RELIC_REGION env var
 * Defaults to 'US' if not set
 */
export function getTestRegion(): 'US' | 'EU' {
  const region = process.env.NEW_RELIC_REGION?.toUpperCase();
  return region === 'EU' ? 'EU' : 'US';
}
