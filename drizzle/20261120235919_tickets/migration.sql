CREATE TABLE `ticket_areas` (
	`name` text PRIMARY KEY,
	`description` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ticket_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`ticketId` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`actor` text,
	`createdAt` text NOT NULL,
	CONSTRAINT `fk_ticket_events_ticketId_tickets_id_fk` FOREIGN KEY (`ticketId`) REFERENCES `tickets`(`id`)
);
--> statement-breakpoint
CREATE TABLE `ticket_links` (
	`ticketId` integer NOT NULL,
	`targetId` integer NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `ticket_links_pk` PRIMARY KEY(`ticketId`, `targetId`, `kind`),
	CONSTRAINT `fk_ticket_links_ticketId_tickets_id_fk` FOREIGN KEY (`ticketId`) REFERENCES `tickets`(`id`),
	CONSTRAINT `fk_ticket_links_targetId_tickets_id_fk` FOREIGN KEY (`targetId`) REFERENCES `tickets`(`id`)
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`repo` text NOT NULL,
	`repoPath` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`type` text NOT NULL,
	`area` text NOT NULL,
	`priority` text NOT NULL,
	`effort` real NOT NULL,
	`duplicateOf` integer,
	`classified` text NOT NULL,
	`body` text NOT NULL,
	`importSource` text,
	`importId` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	CONSTRAINT `fk_tickets_duplicateOf_tickets_id_fk` FOREIGN KEY (`duplicateOf`) REFERENCES `tickets`(`id`)
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `ticketId` integer REFERENCES tickets(id);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_active_ticket_idx` ON `jobs` (`ticketId`) WHERE "jobs"."status" not in ('completed', 'cancelled');--> statement-breakpoint
CREATE INDEX `ticket_events_ticket_idx` ON `ticket_events` (`ticketId`,`id`);--> statement-breakpoint
CREATE INDEX `ticket_links_target_idx` ON `ticket_links` (`targetId`);--> statement-breakpoint
CREATE INDEX `tickets_status_idx` ON `tickets` (`status`);--> statement-breakpoint
CREATE INDEX `tickets_repo_idx` ON `tickets` (`repo`);--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_import_idx` ON `tickets` (`importSource`,`importId`);