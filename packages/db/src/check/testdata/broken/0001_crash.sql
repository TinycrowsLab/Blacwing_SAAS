-- Fails mid-run (simulates a crash after 0000 ran): the whole run must roll back.
INSERT INTO "broken_probe" ("id") VALUES (1);
--> statement-breakpoint
INSERT INTO "no_such_table" ("id") VALUES (1);
