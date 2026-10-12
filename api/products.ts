import { dashboardDeps } from '../server/deps.js';
import { withErrorHandling } from '../server/http/errors.js';
import { createProductsHandler } from '../server/products/handler.js';

const handle = withErrorHandling((request) => createProductsHandler(dashboardDeps())(request));

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
