import { createProcessEventsJob } from '../../server/jobs/process-events.js';
import { jobDeps } from '../../server/messaging-deps.js';

const handle = createProcessEventsJob(jobDeps);

export const GET = handle;
export const POST = handle;
