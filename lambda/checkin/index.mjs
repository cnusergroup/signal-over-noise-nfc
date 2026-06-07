/**
 * Lambda entry point — thin wrapper that delegates to the router.
 */

import { route } from './src/router.mjs';

export const handler = async (event) => {
  return route(event);
};
