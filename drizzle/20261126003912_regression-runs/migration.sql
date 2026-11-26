CREATE TABLE `regression_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`jobId` text NOT NULL,
	`runId` integer NOT NULL,
	`mergeBase` text NOT NULL,
	`head` text NOT NULL,
	`tree` text NOT NULL,
	`configFingerprint` text NOT NULL,
	`testFiles` text NOT NULL,
	`redExit` integer,
	`greenExit` integer,
	`redLog` text,
	`greenLog` text,
	`status` text NOT NULL,
	`startedAt` text NOT NULL,
	`completedAt` text NOT NULL,
	CONSTRAINT `fk_regression_runs_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_regression_runs_runId_verification_runs_id_fk` FOREIGN KEY (`runId`) REFERENCES `verification_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `regression_runs_job_idx` ON `regression_runs` (`jobId`,`id`);