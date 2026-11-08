import type { WorkerStatus } from '../../shared/ipc/contract';

/** The simulation worker's state, in words. */
export const WORKER_STATE_LABEL: Record<WorkerStatus['state'], string> = {
  starting: 'Starting',
  ready: 'Ready',
  failed: 'Failed',
  stopping: 'Stopping',
  stopped: 'Stopped',
};
