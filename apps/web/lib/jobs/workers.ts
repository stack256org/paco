import "server-only";

import { type EmailMessage, sendEmail } from "@/lib/email/mailer";
import { getBoss, QUEUES } from "./queue";

/**
 * Background workers.
 *
 * Registered once at server startup from `instrumentation.ts`. Email delivery
 * runs here rather than inline so a slow or failing SMTP provider never blocks
 * a sign-in request, and so pg-boss can retry it.
 */

let started: Promise<void> | null = null;

async function registerWorkers(): Promise<void> {
  const boss = await getBoss();

  await boss.createQueue(QUEUES.sendEmail).catch(() => {
    // Idempotent; the queue may already exist.
  });

  await boss.work<EmailMessage>(
    QUEUES.sendEmail,
    { batchSize: 5 },
    async (jobs: Array<{ data: EmailMessage }>) => {
      for (const job of jobs) {
        // Throwing marks the job failed so pg-boss retries it with backoff.
        await sendEmail(job.data);
      }
    },
  );

  console.log("[jobs] workers started");
}

/** Start background workers. Safe to call more than once. */
export function startWorkers(): Promise<void> {
  if (!started) {
    started = registerWorkers().catch((error) => {
      // Reset so a later boot can retry instead of silently never working.
      started = null;
      throw error;
    });
  }

  return started;
}
