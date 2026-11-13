CREATE TABLE `artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`jobId` text NOT NULL,
	`stage` text NOT NULL,
	`round` integer,
	`path` text NOT NULL,
	`bytes` integer NOT NULL,
	`createdAt` text NOT NULL,
	CONSTRAINT `fk_artifacts_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`jobId` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`actor` text,
	`createdAt` text NOT NULL,
	CONSTRAINT `fk_events_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`description` text,
	`repo` text NOT NULL,
	`repoPath` text NOT NULL,
	`issueRef` text,
	`baseBranch` text NOT NULL,
	`branch` text,
	`worktreePath` text,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`round` integer DEFAULT 0 NOT NULL,
	`maxRounds` integer DEFAULT 3 NOT NULL,
	`returnStage` text,
	`ownerSession` text,
	`ownerToken` text,
	`leaseExpiresAt` text,
	`prUrl` text,
	`prState` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`completedAt` text
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`jobId` text NOT NULL,
	`round` integer NOT NULL,
	`reviewer` text NOT NULL,
	`verdict` text,
	`artifactId` integer,
	`summary` text,
	`createdAt` text NOT NULL,
	`completedAt` text,
	CONSTRAINT `fk_reviews_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_reviews_artifactId_artifacts_id_fk` FOREIGN KEY (`artifactId`) REFERENCES `artifacts`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_job_path_idx` ON `artifacts` (`jobId`,`path`);--> statement-breakpoint
CREATE INDEX `events_job_idx` ON `events` (`jobId`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_repo_idx` ON `jobs` (`repo`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_job_round_reviewer_idx` ON `reviews` (`jobId`,`round`,`reviewer`);