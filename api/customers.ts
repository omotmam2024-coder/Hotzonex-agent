import { createCustomersHandler } from '../server/dashboard/handlers.js';
import { dashboardApiDeps } from '../server/deps.js';
import { withErrorHandling } from '../server/http/errors.js';

const handle = withErrorHandling((request) => createCustomersHandler(dashboardApiDeps())(request));

export const GET = handle;
export const PATCH = handle;
