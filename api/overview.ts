import { createOverviewHandler } from '../server/dashboard/handlers.js';
import { dashboardApiDeps } from '../server/deps.js';
import { withErrorHandling } from '../server/http/errors.js';

export const GET = withErrorHandling((request) => createOverviewHandler(dashboardApiDeps())(request));
