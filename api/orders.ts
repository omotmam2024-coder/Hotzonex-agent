import { createOrdersHandler } from '../server/dashboard/handlers.js';
import { dashboardApiDeps } from '../server/deps.js';
import { withErrorHandling } from '../server/http/errors.js';

const handle = withErrorHandling((request) => createOrdersHandler(dashboardApiDeps())(request));

export const GET = handle;
export const PATCH = handle;
