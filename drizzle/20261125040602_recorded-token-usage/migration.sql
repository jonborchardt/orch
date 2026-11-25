CREATE TABLE `token_usage` (
	`ref` text PRIMARY KEY,
	`jobId` text NOT NULL,
	`source` text NOT NULL,
	`firstHour` integer,
	`lastHour` integer,
	`hours` text NOT NULL,
	`recordedAt` text NOT NULL,
	CONSTRAINT `fk_token_usage_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `token_usage_hours_idx` ON `token_usage` (`lastHour`,`firstHour`);