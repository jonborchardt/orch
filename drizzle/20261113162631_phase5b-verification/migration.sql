CREATE TABLE `integrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`jobId` text NOT NULL,
	`status` text NOT NULL,
	`fromHead` text NOT NULL,
	`baseRef` text NOT NULL,
	`baseSha` text NOT NULL,
	`mergeBase` text,
	`decisionHead` text,
	`verificationRunId` integer,
	`resultHead` text,
	`conflicts` text,
	`changedFiles` text,
	`material` text,
	`startedAt` text NOT NULL,
	`completedAt` text,
	CONSTRAINT `fk_integrations_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `verification_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`runId` integer NOT NULL,
	`checkId` text NOT NULL,
	`command` text NOT NULL,
	`args` text NOT NULL,
	`cwd` text NOT NULL,
	`required` integer NOT NULL,
	`timeoutMs` integer NOT NULL,
	`status` text NOT NULL,
	`startedAt` text,
	`completedAt` text,
	`durationMs` integer,
	`exitCode` integer,
	`signal` text,
	`outputPath` text,
	`outputSha256` text,
	`truncated` integer DEFAULT false NOT NULL,
	`error` text,
	CONSTRAINT `fk_verification_checks_runId_verification_runs_id_fk` FOREIGN KEY (`runId`) REFERENCES `verification_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `verification_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`jobId` text NOT NULL,
	`head` text NOT NULL,
	`tree` text NOT NULL,
	`dirty` text NOT NULL,
	`configFingerprint` text NOT NULL,
	`policySource` text NOT NULL,
	`policyHead` text,
	`status` text NOT NULL,
	`actor` text,
	`startedAt` text NOT NULL,
	`completedAt` text,
	CONSTRAINT `fk_verification_runs_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `policy` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `policyHead` text;--> statement-breakpoint
CREATE INDEX `integrations_job_idx` ON `integrations` (`jobId`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `verification_checks_run_check_idx` ON `verification_checks` (`runId`,`checkId`);--> statement-breakpoint
CREATE INDEX `verification_runs_job_idx` ON `verification_runs` (`jobId`,`id`);