import { dashboardDeps } from '../server/deps.js';
import { withErrorHandling } from '../server/http/errors.js';
import { createMeHandler } from '../server/me/handler.js';

export const GET = withErrorHandling((request) => createMeHandler(dashboardDeps())(request));
