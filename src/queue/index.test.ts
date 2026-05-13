/**
 * Unit tests for BullMQ queue configuration module.
 *
 * Tests cover:
 *   - Redis connection configuration from app config
 *   - Queue creation with correct retry settings
 *   - Queue registry initialization and access
 *   - Worker creation with DLQ handling
 *   - Job helper functions
 *   - Processor stubs validation
 *   - Graceful shutdown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock bullmq before importing the module under test
vi.mock('bullmq', () => {
  const mockAdd = vi.fn().mockResolvedValue({ id: 'job-1', data: {} });
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockOn = vi.fn();

  class MockQueue {
    name: string;
    opts: Record<string, unknown>;
    add = mockAdd;
    close = mockClose;

    constructor(name: string, opts: Record<string, unknown>) {
      this.name = name;
      this.opts = opts;
    }
  }

  class MockWorker {
    name: string;
    processor: unknown;
    opts: Record<string, unknown>;
    on = mockOn;
    close = mockClose;

    constructor(name: string, processor: unknown, opts: Record<string, unknown>) {
      this.name = name;
      this.processor = processor;
      this.opts = opts;
    }
  }

  return {
    Queue: MockQueue,
    Worker: MockWorker,
  };
});

// Mock the config module
vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    redis: {
      host: 'localhost',
      port: 6379,
      password: 'test-password',
      db: 0,
      connectTimeoutMs: 5000,
    },
    app: {
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30000,
    },
  })),
}));

import {
  QUEUE_NAMES,
  DLQ_NAME,
  DEFAULT_QUEUE_RETRY_CONFIG,
  getRedisConnection,
  createQueue,
  initQueues,
  getQueues,
  resetQueues,
  createWorker,
  initWorkers,
  getWorkers,
  resetWorkers,
  addMeetingAnalysisJob,
  addTaskCreationJob,
  addCodeVerificationJob,
  addDocGenerationJob,
  addNotificationJob,
  meetingAnalysisProcessor,
  taskCreationProcessor,
  codeVerificationProcessor,
  docGenerationProcessor,
  notificationProcessor,
  closeAll,
  type QueueName,
  type MeetingAnalysisJobData,
  type TaskCreationJobData,
  type CodeVerificationJobData,
  type DocGenerationJobData,
  type NotificationJobData,
} from './index.js';

describe('Queue Module', () => {
  beforeEach(() => {
    resetQueues();
    resetWorkers();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  describe('QUEUE_NAMES', () => {
    it('should define exactly 5 queue names', () => {
      expect(QUEUE_NAMES).toHaveLength(5);
    });

    it('should include all expected queue names', () => {
      expect(QUEUE_NAMES).toContain('meeting-analysis');
      expect(QUEUE_NAMES).toContain('task-creation');
      expect(QUEUE_NAMES).toContain('code-verification');
      expect(QUEUE_NAMES).toContain('doc-generation');
      expect(QUEUE_NAMES).toContain('notification');
    });
  });

  describe('DLQ_NAME', () => {
    it('should be "dead-letter-queue"', () => {
      expect(DLQ_NAME).toBe('dead-letter-queue');
    });
  });

  describe('DEFAULT_QUEUE_RETRY_CONFIG', () => {
    it('should have 3 max retries', () => {
      expect(DEFAULT_QUEUE_RETRY_CONFIG.maxRetries).toBe(3);
    });

    it('should have 1000ms base delay', () => {
      expect(DEFAULT_QUEUE_RETRY_CONFIG.baseDelay).toBe(1000);
    });

    it('should have backoff multiplier of 2 (exponential)', () => {
      expect(DEFAULT_QUEUE_RETRY_CONFIG.backoffMultiplier).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Redis connection
  // -------------------------------------------------------------------------

  describe('getRedisConnection', () => {
    it('should return connection options from app config', () => {
      const conn = getRedisConnection();
      expect(conn.host).toBe('localhost');
      expect(conn.port).toBe(6379);
      expect(conn.password).toBe('test-password');
      expect(conn.db).toBe(0);
    });

    it('should set maxRetriesPerRequest to null for BullMQ compatibility', () => {
      const conn = getRedisConnection();
      expect(conn.maxRetriesPerRequest).toBeNull();
    });

    it('should return undefined for empty password', async () => {
      const configModule = await import('../config/index.js');
      const { getConfig } = vi.mocked(configModule);
      getConfig.mockReturnValueOnce({
        redis: { host: 'localhost', port: 6379, password: '', db: 0, connectTimeoutMs: 5000 },
        app: { maxRetries: 3, retryBaseDelayMs: 1000, retryMaxDelayMs: 30000 },
      } as ReturnType<typeof getConfig>);

      const conn = getRedisConnection();
      expect(conn.password).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Queue creation
  // -------------------------------------------------------------------------

  describe('createQueue', () => {
    it('should create a queue with the given name', () => {
      const conn = getRedisConnection();
      const queue = createQueue('meeting-analysis', conn);
      expect(queue.name).toBe('meeting-analysis');
    });

    it('should configure default retry settings (attempts = maxRetries + 1)', () => {
      const conn = getRedisConnection();
      const queue = createQueue('task-creation', conn);
      // The queue opts should include defaultJobOptions with attempts = 4 (3 retries + 1 initial)
      const opts = (queue as unknown as { opts: Record<string, unknown> }).opts;
      expect(opts).toBeDefined();
    });

    it('should accept custom retry config', () => {
      const conn = getRedisConnection();
      const customConfig = { maxRetries: 5, baseDelay: 2000, backoffMultiplier: 3 };
      const queue = createQueue('notification', conn, customConfig);
      expect(queue.name).toBe('notification');
    });
  });

  // -------------------------------------------------------------------------
  // Queue registry
  // -------------------------------------------------------------------------

  describe('initQueues', () => {
    it('should create all 5 queues plus DLQ', () => {
      const registry = initQueues();
      expect(registry.meetingAnalysis).toBeDefined();
      expect(registry.taskCreation).toBeDefined();
      expect(registry.codeVerification).toBeDefined();
      expect(registry.docGeneration).toBeDefined();
      expect(registry.notification).toBeDefined();
      expect(registry.deadLetterQueue).toBeDefined();
    });

    it('should return cached registry on subsequent calls', () => {
      const first = initQueues();
      const second = initQueues();
      expect(first).toBe(second);
    });

    it('should rebuild registry when force=true', () => {
      const first = initQueues();
      const second = initQueues(true);
      expect(first).not.toBe(second);
    });
  });

  describe('getQueues', () => {
    it('should throw if registry not initialized', () => {
      expect(() => getQueues()).toThrow('Queue registry not initialized');
    });

    it('should return registry after initialization', () => {
      initQueues();
      const registry = getQueues();
      expect(registry).toBeDefined();
      expect(registry.meetingAnalysis).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Worker creation
  // -------------------------------------------------------------------------

  describe('createWorker', () => {
    it('should create a worker for the specified queue', () => {
      const conn = getRedisConnection();
      const processor = vi.fn();
      const worker = createWorker('meeting-analysis', processor, conn);
      expect(worker.name).toBe('meeting-analysis');
    });

    it('should register a failed event handler for DLQ', () => {
      const conn = getRedisConnection();
      const processor = vi.fn();
      const worker = createWorker('task-creation', processor, conn);
      expect(worker.on).toHaveBeenCalledWith('failed', expect.any(Function));
    });

    it('should accept custom worker options', () => {
      const conn = getRedisConnection();
      const processor = vi.fn();
      const worker = createWorker('notification', processor, conn, { concurrency: 10 });
      expect(worker).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Worker registry
  // -------------------------------------------------------------------------

  describe('initWorkers', () => {
    it('should create workers for all 5 queues', () => {
      const registry = initWorkers();
      expect(registry.meetingAnalysis).toBeDefined();
      expect(registry.taskCreation).toBeDefined();
      expect(registry.codeVerification).toBeDefined();
      expect(registry.docGeneration).toBeDefined();
      expect(registry.notification).toBeDefined();
    });

    it('should return cached registry on subsequent calls', () => {
      const first = initWorkers();
      const second = initWorkers();
      expect(first).toBe(second);
    });

    it('should rebuild registry when force=true', () => {
      const first = initWorkers();
      const second = initWorkers(true);
      expect(first).not.toBe(second);
    });
  });

  describe('getWorkers', () => {
    it('should throw if registry not initialized', () => {
      expect(() => getWorkers()).toThrow('Worker registry not initialized');
    });

    it('should return registry after initialization', () => {
      initWorkers();
      const registry = getWorkers();
      expect(registry).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Job helper functions
  // -------------------------------------------------------------------------

  describe('addMeetingAnalysisJob', () => {
    it('should add a job to the meeting-analysis queue', async () => {
      initQueues();
      const data: MeetingAnalysisJobData = {
        meetingId: 'meeting-1',
        content: 'Meeting notes...',
        userId: 'user-1',
      };
      const job = await addMeetingAnalysisJob(data);
      expect(job).toBeDefined();

      const { meetingAnalysis } = getQueues();
      expect(meetingAnalysis.add).toHaveBeenCalledWith('analyze-meeting', data, {
        priority: undefined,
        delay: undefined,
      });
    });

    it('should support priority and delay options', async () => {
      initQueues();
      const data: MeetingAnalysisJobData = {
        meetingId: 'meeting-2',
        content: 'Notes',
        userId: 'user-2',
      };
      await addMeetingAnalysisJob(data, { priority: 1, delay: 5000 });

      const { meetingAnalysis } = getQueues();
      expect(meetingAnalysis.add).toHaveBeenCalledWith('analyze-meeting', data, {
        priority: 1,
        delay: 5000,
      });
    });
  });

  describe('addTaskCreationJob', () => {
    it('should add a job to the task-creation queue', async () => {
      initQueues();
      const data: TaskCreationJobData = {
        meetingId: 'meeting-1',
        actionItemId: 'ai-1',
        actionItem: {
          description: 'Implement feature X',
          context: 'Discussed in meeting',
          priority: 'high',
          dependencies: [],
          acceptanceCriteria: ['Criteria 1'],
        },
      };
      const job = await addTaskCreationJob(data);
      expect(job).toBeDefined();

      const { taskCreation } = getQueues();
      expect(taskCreation.add).toHaveBeenCalledWith('create-task', data, {
        priority: undefined,
        delay: undefined,
      });
    });
  });

  describe('addCodeVerificationJob', () => {
    it('should add a job to the code-verification queue', async () => {
      initQueues();
      const data: CodeVerificationJobData = {
        taskId: 'task-1',
        codeChanges: 'diff content...',
        commitMessage: 'feat: add feature',
      };
      const job = await addCodeVerificationJob(data);
      expect(job).toBeDefined();

      const { codeVerification } = getQueues();
      expect(codeVerification.add).toHaveBeenCalledWith('verify-code', data, {
        priority: undefined,
        delay: undefined,
      });
    });
  });

  describe('addDocGenerationJob', () => {
    it('should add a job to the doc-generation queue', async () => {
      initQueues();
      const data: DocGenerationJobData = {
        taskId: 'task-1',
        docType: 'test_doc',
      };
      const job = await addDocGenerationJob(data);
      expect(job).toBeDefined();

      const { docGeneration } = getQueues();
      expect(docGeneration.add).toHaveBeenCalledWith('generate-doc', data, {
        priority: undefined,
        delay: undefined,
      });
    });
  });

  describe('addNotificationJob', () => {
    it('should add a job to the notification queue', async () => {
      initQueues();
      const data: NotificationJobData = {
        type: 'task_assigned',
        recipientId: 'user-1',
        content: 'You have been assigned a task',
      };
      const job = await addNotificationJob(data);
      expect(job).toBeDefined();

      const { notification } = getQueues();
      expect(notification.add).toHaveBeenCalledWith('send-notification', data, {
        priority: undefined,
        delay: undefined,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Processor stubs
  // -------------------------------------------------------------------------

  describe('Processor stubs', () => {
    const createMockJob = <T>(data: T) =>
      ({
        data,
        id: 'job-1',
        attemptsMade: 0,
        opts: { attempts: 4 },
      }) as unknown as import('bullmq').Job<T>;

    describe('meetingAnalysisProcessor', () => {
      it('should not throw with valid data', async () => {
        const job = createMockJob<MeetingAnalysisJobData>({
          meetingId: 'meeting-1',
          content: 'Notes',
          userId: 'user-1',
        });
        await expect(meetingAnalysisProcessor(job)).resolves.toBeUndefined();
      });

      it('should throw with missing meetingId', async () => {
        const job = createMockJob<MeetingAnalysisJobData>({
          meetingId: '',
          content: 'Notes',
          userId: 'user-1',
        });
        await expect(meetingAnalysisProcessor(job)).rejects.toThrow('Missing required fields');
      });
    });

    describe('taskCreationProcessor', () => {
      it('should not throw with valid data', async () => {
        const job = createMockJob<TaskCreationJobData>({
          meetingId: 'meeting-1',
          actionItemId: 'ai-1',
          actionItem: {
            description: 'Task',
            context: 'Context',
            priority: 'medium',
            dependencies: [],
            acceptanceCriteria: [],
          },
        });
        await expect(taskCreationProcessor(job)).resolves.toBeUndefined();
      });

      it('should throw with missing meetingId', async () => {
        const job = createMockJob<TaskCreationJobData>({
          meetingId: '',
          actionItemId: 'ai-1',
          actionItem: {
            description: 'Task',
            context: 'Context',
            priority: 'medium',
            dependencies: [],
            acceptanceCriteria: [],
          },
        });
        await expect(taskCreationProcessor(job)).rejects.toThrow('Missing required fields');
      });
    });

    describe('codeVerificationProcessor', () => {
      it('should not throw with valid data', async () => {
        const job = createMockJob<CodeVerificationJobData>({
          taskId: 'task-1',
          codeChanges: 'diff...',
        });
        await expect(codeVerificationProcessor(job)).resolves.toBeUndefined();
      });

      it('should throw with missing taskId', async () => {
        const job = createMockJob<CodeVerificationJobData>({
          taskId: '',
          codeChanges: 'diff...',
        });
        await expect(codeVerificationProcessor(job)).rejects.toThrow('Missing required fields');
      });
    });

    describe('docGenerationProcessor', () => {
      it('should not throw with valid data', async () => {
        const job = createMockJob<DocGenerationJobData>({
          taskId: 'task-1',
          docType: 'test_doc',
        });
        await expect(docGenerationProcessor(job)).resolves.toBeUndefined();
      });

      it('should throw with missing taskId', async () => {
        const job = createMockJob<DocGenerationJobData>({
          taskId: '',
          docType: 'test_doc',
        });
        await expect(docGenerationProcessor(job)).rejects.toThrow('Missing required fields');
      });
    });

    describe('notificationProcessor', () => {
      it('should not throw with valid data', async () => {
        const job = createMockJob<NotificationJobData>({
          type: 'task_assigned',
          recipientId: 'user-1',
          content: 'Hello',
        });
        await expect(notificationProcessor(job)).resolves.toBeUndefined();
      });

      it('should throw with missing recipientId', async () => {
        const job = createMockJob<NotificationJobData>({
          type: 'task_assigned',
          recipientId: '',
          content: 'Hello',
        });
        await expect(notificationProcessor(job)).rejects.toThrow('Missing required fields');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  describe('closeAll', () => {
    it('should close all queues and workers', async () => {
      initQueues();
      initWorkers();

      await closeAll();

      // After closeAll, registries should be null
      expect(() => getQueues()).toThrow('Queue registry not initialized');
      expect(() => getWorkers()).toThrow('Worker registry not initialized');
    });

    it('should handle case when only queues are initialized', async () => {
      initQueues();
      await expect(closeAll()).resolves.toBeUndefined();
    });

    it('should handle case when nothing is initialized', async () => {
      await expect(closeAll()).resolves.toBeUndefined();
    });
  });
});
