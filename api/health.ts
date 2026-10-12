import { handleHealth } from '../server/health.js';

export function GET(request: Request): Response {
  return handleHealth(request);
}

export function HEAD(request: Request): Response {
  return handleHealth(request);
}
