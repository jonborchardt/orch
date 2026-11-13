ALTER TABLE `artifacts` ADD `sha256` text;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `marker` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `ciStatus` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `ciCheckedAt` text;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_worktree_idx` ON `jobs` (`worktreePath`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_repo_branch_idx` ON `jobs` (`repo`,`branch`);