import { createConversationsHandler } from '../server/dashboard/handlers.js';
import { dashboardApiDeps } from '../server/deps.js';
import { withErrorHandling } from '../server/http/errors.js';

const handle = withErrorHandling((request) => createConversationsHandler(dashboardApiDeps())(request));

export const GET = handle;
export const PATCH = handle;
export const POST = handle;
