ALTER TABLE `jobs` ADD `ciHead` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `ciRepairs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `maxCiRepairs` integer DEFAULT 2 NOT NULL;