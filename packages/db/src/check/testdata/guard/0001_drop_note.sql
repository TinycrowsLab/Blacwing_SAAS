-- A destructive (data-losing) forward migration: refused in production without the flag.
ALTER TABLE "guard_probe" DROP COLUMN "note";
