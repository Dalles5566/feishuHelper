/**
 * BullMQ task queue configuration and management.
 *
 * Defines 5 named queues for async workflow processing:
 *   - meeting-analysis: Process meeting content analysis jobs
 *   - task-creation: Process task creation from action items
 *   - code-verification: Process code verification against task criteria
 *   - doc-generation: Process document generation jobs
 *   - notification: Process notification delivery jobs
 *
 * Each queue is configured with exponential backoff retry (default 3 attempts)
 * and dead letter queue (DLQ) handling for jobs that exhaust all retries.
 *
 * Requirements: 2.6, 10.2
 */

import { Queue, Worker, type Job, type ConnectionOptions, type WorkerOptions } from 'bullmq';
import { getConfig } from '../config/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Names of all application queues. */
export type QueueName =
  | 'meeting-analysis'
  | 'task-creation'
  | 'code-verification'
  | 'doc-generation'
  | 'notification';

/** Configuration for queue retry behavior. */
export interface QueueRetryConfig {
  /** Maximum number of retry attempts before moving to DLQ. */
  maxRetries: number;
  /** Base delay in milliseconds for exponential backoff. */
  baseDelay: number;
  /** Backoff multiplier (default 2 for exponential). */
  backoffMultiplier: number;
}

/** Job data for meeting analysis queue. */
export interface MeetingAnalysisJobData {
  meetingId: string;
  content: string;
  userId: string;
}

/** Job data for task creation queue. */
export interface TaskCreationJobData {
  meetingId: string;
  actionItemId: string;
  actionItem: {
    description: string;
    context: string;
    priority: 'high' | 'medium' | 'low';
    suggestedAssignee?: string;
    dependencies: string[];
    acceptanceCriteria: string[];
  };
}

/** Job data for code verification queue. */
export interface CodeVerificationJobData {
  taskId: string;
  codeChanges: string;
  commitMessage?: string;
}

/** Job data for doc generation queue. */
export interface DocGenerationJobData {
  taskId: string;
  docType: 'test_doc' | 'md_doc' | 'user_manual';
  context?: Record<string, unknown>;
}

/** Job data for notification queue. */
export interface NotificationJobData {
  type: 'task_assigned' | 'state_changed' | 'requirement_updated' | 'verification_result';
  recipientId: string;
  chatId?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Dead letter queue job data wraps the original job info. */
export interface DeadLetterJobData {
  originalQueue: QueueName;
  originalJobId: string;
  originalData: unknown;
  failedReason: string;
  attemptsMade: number;
  failedAt: string;
}

/** Worker processor function type. */
export type JobProcessor<T> = (job: Job<T>) => Promise<void>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All queue names in the system. */
export const QUEUE_NAMES: readonly QueueName[] = [
  'meeting-analysis',
  'task-creation',
  'code-verification',
  'doc-generation',
  'notification',
] as const;

/** Dead letter queue name. */
export const DLQ_NAME = 'dead-letter-queue';

/** Default retry configuration for all queues. */
export const DEFAULT_QUEUE_RETRY_CONFIG: QueueRetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  backoffMultiplier: 2,
};

// ---------------------------------------------------------------------------
// Redis connection
// ---------------------------------------------------------------------------

/**
 * Build Redis connection options from application config.
 */
export function getRedisConnection(): ConnectionOptions {
  const { redis } = getConfig();
  return {
    host: redis.host,
    port: redis.port,
    password: redis.password || undefined,
    db: redis.db,
    maxRetriesPerRequest: null,
  };
}

// ---------------------------------------------------------------------------
// Queue creation
// ---------------------------------------------------------------------------

/**
 * Create a BullMQ Queue instance with the given name and retry config.
 */
export function createQueue(
  name: QueueName | typeof DLQ_NAME,
  connection: ConnectionOptions,
  retryConfig: QueueRetryConfig = DEFAULT_QUEUE_RETRY_CONFIG,
): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: retryConfig.maxRetries + 1, // attempts includes the initial try
      backoff: {
        type: 'exponential',
        delay: retryConfig.baseDelay,
      },
      removeOnComplete: { count: 1000 },
      removeOnFail: false, // Keep failed jobs for DLQ processing
    },
  });
}

// ---------------------------------------------------------------------------
// Queue registry
// ---------------------------------------------------------------------------

/** Registry holding all queue instances. */
export interface QueueRegistry {
  meetingAnalysis: Queue;
  taskCreation: Queue;
  codeVerification: Queue;
  docGeneration: Queue;
  notification: Queue;
  deadLetterQueue: Queue;
}

let _registry: QueueRegistry | null = null;

/**
 * Initialize all queues and return the registry.
 * Returns cached registry on subsequent calls unless force=true.
 */
export function initQueues(force = false): QueueRegistry {
  if (_registry && !force) return _registry;

  const connection = getRedisConnection();

  _registry = {
    meetingAnalysis: createQueue('meeting-analysis', connection),
    taskCreation: createQueue('task-creation', connection),
    codeVerification: createQueue('code-verification', connection),
    docGeneration: createQueue('doc-generation', connection),
    notification: createQueue('notification', connection),
    deadLetterQueue: createQueue(DLQ_NAME, connection, {
      maxRetries: 0,
      baseDelay: 0,
      backoffMultiplier: 0,
    }),
  };

  return _registry;
}

/**
 * Get the current queue registry. Throws if not initialized.
 */
export function getQueues(): QueueRegistry {
  if (!_registry) {
    throw new Error('Queue registry not initialized. Call initQueues() first.');
  }
  return _registry;
}

/**
 * Reset the queue registry (useful for testing).
 */
export function resetQueues(): void {
  _registry = null;
}

// ---------------------------------------------------------------------------
// Worker creation
// ---------------------------------------------------------------------------

/**
 * Create a worker for a specific queue with DLQ handling on final failure.
 *
 * When a job exhausts all retry attempts, it is moved to the dead letter queue
 * with metadata about the failure.
 */
export function createWorker<T>(
  queueName: QueueName,
  processor: JobProcessor<T>,
  connection: ConnectionOptions,
  options?: Partial<WorkerOptions>,
): Worker<T> {
  const worker = new Worker<T>(
    queueName,
    async (job: Job<T>) => {
      await processor(job);
    },
    {
      connection,
      concurrency: 5,
      ...options,
    },
  );

  // Handle failed jobs - move to DLQ after all retries exhausted
  worker.on('failed', async (job: Job<T> | undefined, err: Error) => {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? DEFAULT_QUEUE_RETRY_CONFIG.maxRetries + 1;

    // Only move to DLQ when all retries are exhausted
    if (job.attemptsMade >= maxAttempts) {
      await moveToDeadLetterQueue(queueName, job, err);
    }
  });

  return worker;
}

/**
 * Move a failed job to the dead letter queue.
 */
async function moveToDeadLetterQueue<T>(
  originalQueue: QueueName,
  job: Job<T>,
  error: Error,
): Promise<void> {
  const registry = getQueues();
  const dlqData: DeadLetterJobData = {
    originalQueue,
    originalJobId: job.id ?? 'unknown',
    originalData: job.data,
    failedReason: error.message,
    attemptsMade: job.attemptsMade,
    failedAt: new Date().toISOString(),
  };

  await registry.deadLetterQueue.add(`dlq-${originalQueue}`, dlqData, {
    attempts: 1,
    removeOnComplete: false,
  });
}

// ---------------------------------------------------------------------------
// Worker stubs (to be connected to actual services in Task 14)
// ---------------------------------------------------------------------------

/**
 * Default meeting analysis processor stub.
 * Will be connected to MeetingAnalyzer service in Task 14.
 */
export const meetingAnalysisProcessor: JobProcessor<MeetingAnalysisJobData> = async (job) => {
  // Stub: will be replaced with actual MeetingAnalyzer.analyze() call
  const { meetingId, content } = job.data;
  if (!meetingId || !content) {
    throw new Error('Missing required fields: meetingId and content');
  }
  // Placeholder for actual processing
};

/**
 * Default task creation processor stub.
 * Will be connected to TaskManager service in Task 14.
 */
export const taskCreationProcessor: JobProcessor<TaskCreationJobData> = async (job) => {
  // Stub: will be replaced with actual TaskManager.createTask() call
  const { meetingId, actionItem } = job.data;
  if (!meetingId || !actionItem) {
    throw new Error('Missing required fields: meetingId and actionItem');
  }
  // Placeholder for actual processing
};

/**
 * Default code verification processor stub.
 * Will be connected to CodeVerifier service in Task 14.
 */
export const codeVerificationProcessor: JobProcessor<CodeVerificationJobData> = async (job) => {
  // Stub: will be replaced with actual CodeVerifier.verify() call
  const { taskId, codeChanges } = job.data;
  if (!taskId || !codeChanges) {
    throw new Error('Missing required fields: taskId and codeChanges');
  }
  // Placeholder for actual processing
};

/**
 * Default doc generation processor stub.
 * Will be connected to DocGenerator service in Task 14.
 */
export const docGenerationProcessor: JobProcessor<DocGenerationJobData> = async (job) => {
  // Stub: will be replaced with actual DocGenerator call
  const { taskId, docType } = job.data;
  if (!taskId || !docType) {
    throw new Error('Missing required fields: taskId and docType');
  }
  // Placeholder for actual processing
};

/**
 * Default notification processor stub.
 * Will be connected to notification service in Task 14.
 */
export const notificationProcessor: JobProcessor<NotificationJobData> = async (job) => {
  // Stub: will be replaced with actual notification delivery
  const { type, recipientId, content } = job.data;
  if (!type || !recipientId || !content) {
    throw new Error('Missing required fields: type, recipientId, and content');
  }
  // Placeholder for actual processing
};

// ---------------------------------------------------------------------------
// Worker registry
// ---------------------------------------------------------------------------

/** Registry holding all worker instances. */
export interface WorkerRegistry {
  meetingAnalysis: Worker;
  taskCreation: Worker;
  codeVerification: Worker;
  docGeneration: Worker;
  notification: Worker;
}

let _workerRegistry: WorkerRegistry | null = null;

/**
 * Initialize all workers with their default processor stubs.
 * Returns cached registry on subsequent calls unless force=true.
 */
export function initWorkers(force = false): WorkerRegistry {
  if (_workerRegistry && !force) return _workerRegistry;

  const connection = getRedisConnection();

  _workerRegistry = {
    meetingAnalysis: createWorker<MeetingAnalysisJobData>(
      'meeting-analysis',
      meetingAnalysisProcessor,
      connection,
    ),
    taskCreation: createWorker<TaskCreationJobData>(
      'task-creation',
      taskCreationProcessor,
      connection,
    ),
    codeVerification: createWorker<CodeVerificationJobData>(
      'code-verification',
      codeVerificationProcessor,
      connection,
    ),
    docGeneration: createWorker<DocGenerationJobData>(
      'doc-generation',
      docGenerationProcessor,
      connection,
    ),
    notification: createWorker<NotificationJobData>(
      'notification',
      notificationProcessor,
      connection,
    ),
  };

  return _workerRegistry;
}

/**
 * Get the current worker registry. Throws if not initialized.
 */
export function getWorkers(): WorkerRegistry {
  if (!_workerRegistry) {
    throw new Error('Worker registry not initialized. Call initWorkers() first.');
  }
  return _workerRegistry;
}

/**
 * Reset the worker registry (useful for testing).
 */
export function resetWorkers(): void {
  _workerRegistry = null;
}

// ---------------------------------------------------------------------------
// Job helper functions
// ---------------------------------------------------------------------------

/**
 * Add a meeting analysis job to the queue.
 */
export async function addMeetingAnalysisJob(
  data: MeetingAnalysisJobData,
  options?: { priority?: number; delay?: number },
): Promise<Job<MeetingAnalysisJobData>> {
  const { meetingAnalysis } = getQueues();
  return meetingAnalysis.add('analyze-meeting', data, {
    priority: options?.priority,
    delay: options?.delay,
  });
}

/**
 * Add a task creation job to the queue.
 */
export async function addTaskCreationJob(
  data: TaskCreationJobData,
  options?: { priority?: number; delay?: number },
): Promise<Job<TaskCreationJobData>> {
  const { taskCreation } = getQueues();
  return taskCreation.add('create-task', data, {
    priority: options?.priority,
    delay: options?.delay,
  });
}

/**
 * Add a code verification job to the queue.
 */
export async function addCodeVerificationJob(
  data: CodeVerificationJobData,
  options?: { priority?: number; delay?: number },
): Promise<Job<CodeVerificationJobData>> {
  const { codeVerification } = getQueues();
  return codeVerification.add('verify-code', data, {
    priority: options?.priority,
    delay: options?.delay,
  });
}

/**
 * Add a doc generation job to the queue.
 */
export async function addDocGenerationJob(
  data: DocGenerationJobData,
  options?: { priority?: number; delay?: number },
): Promise<Job<DocGenerationJobData>> {
  const { docGeneration } = getQueues();
  return docGeneration.add('generate-doc', data, {
    priority: options?.priority,
    delay: options?.delay,
  });
}

/**
 * Add a notification job to the queue.
 */
export async function addNotificationJob(
  data: NotificationJobData,
  options?: { priority?: number; delay?: number },
): Promise<Job<NotificationJobData>> {
  const { notification } = getQueues();
  return notification.add('send-notification', data, {
    priority: options?.priority,
    delay: options?.delay,
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Close all queues and workers gracefully.
 */
export async function closeAll(): Promise<void> {
  if (_workerRegistry) {
    await Promise.all([
      _workerRegistry.meetingAnalysis.close(),
      _workerRegistry.taskCreation.close(),
      _workerRegistry.codeVerification.close(),
      _workerRegistry.docGeneration.close(),
      _workerRegistry.notification.close(),
    ]);
    _workerRegistry = null;
  }

  if (_registry) {
    await Promise.all([
      _registry.meetingAnalysis.close(),
      _registry.taskCreation.close(),
      _registry.codeVerification.close(),
      _registry.docGeneration.close(),
      _registry.notification.close(),
      _registry.deadLetterQueue.close(),
    ]);
    _registry = null;
  }
}
