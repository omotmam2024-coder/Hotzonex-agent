import { createBusinessHandler } from '../server/business/handler.js';
import { dashboardDeps } from '../server/deps.js';
import { withErrorHandling } from '../server/http/errors.js';

const handle = withErrorHandling((request) => createBusinessHandler(dashboardDeps())(request));

export const GET = handle;
export const PATCH = handle;
