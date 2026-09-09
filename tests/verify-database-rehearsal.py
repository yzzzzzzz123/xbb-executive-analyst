"""Isolated SQLite rehearsal, not a production migration or database adapter.

Only a new TemporaryDirectory database is opened. The fixture has no business
records. SQLite transactions demonstrate checkpoints, rollback, compatibility
and guards; they do not establish PostgreSQL/MySQL DDL, locks, replication,
concurrent-writer safety, money-rounding policy, maintenance duration or an SLA.
"""

from decimal import Decimal
import hashlib
import json
from pathlib import Path
import random
import sqlite3
import tempfile
import unittest


class InjectedFailure(RuntimeError):
    pass


def exact_fixture_cents(value):
    """Reject, never silently round: only this fixture's exact 2-decimal values."""
    amount = Decimal(str(value))
    if not amount.is_finite():
        raise ValueError("non-finite fixture amount")
    cents = amount * 100
    if cents != cents.to_integral_value():
        raise ValueError("fixture precision would be lost")
    if cents < -(2**63) or cents > 2**63 - 1:
        raise ValueError("integer overflow")
    return int(cents)


def legacy_rows(connection):
    return connection.execute("SELECT id, amount, legacy_label FROM orders ORDER BY id").fetchall()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode("utf-8")).hexdigest()


def backfill_batch(connection, batch_size=17, fail_after=None):
    if not isinstance(batch_size, int) or isinstance(batch_size, bool) or not 1 <= batch_size <= 100:
        raise ValueError("batch size must be 1..100")
    # Work and checkpoint share one transaction: a failed batch cannot advance
    # the checkpoint. Keyset traversal bounds each transaction's update count.
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        cursor = connection.execute("SELECT last_id FROM migration_checkpoint WHERE id = 1").fetchone()[0]
        rows = connection.execute(
            "SELECT id, amount FROM orders WHERE id > ? AND amount_cents IS NULL ORDER BY id LIMIT ?",
            (cursor, batch_size),
        ).fetchall()
        for index, (row_id, amount) in enumerate(rows, start=1):
            connection.execute(
                "UPDATE orders SET amount_cents = ? WHERE id = ? AND amount_cents IS NULL",
                (exact_fixture_cents(amount), row_id),
            )
            if index == fail_after:
                raise InjectedFailure("synthetic mid-batch failure")
        if rows:
            connection.execute("UPDATE migration_checkpoint SET last_id = ? WHERE id = 1", (rows[-1][0],))
    return len(rows)


def validate_ready(connection):
    rows = connection.execute("SELECT id, amount, amount_cents FROM orders ORDER BY id").fetchall()
    for _row_id, amount, cents in rows:
        if not isinstance(cents, int) or cents != exact_fixture_cents(amount):
            raise ValueError("cutover blocked: old and new fields disagree or backfill incomplete")
    return len(rows)


def activate_new_reader(connection, inject_failure=False):
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        validate_ready(connection)
        connection.execute("CREATE VIEW current_orders AS SELECT id, amount_cents, legacy_label FROM orders")
        connection.execute("UPDATE migration_checkpoint SET phase = 'read-new' WHERE id = 1")
        if inject_failure:
            raise InjectedFailure("synthetic activation failure")


def run_rehearsal():
    case = unittest.TestCase()
    rng = random.Random(20260909)
    fixture_cents = [0, 1, -1, 599, -12345, 1000001] + [rng.randint(-500000, 500000) for _ in range(91)]
    fixture = [(index + 1, float(Decimal(cents) / 100), f"synthetic-row-{index + 1}") for index, cents in enumerate(fixture_cents)]
    with tempfile.TemporaryDirectory(prefix="xbb-sqlite-rehearsal-") as temporary:
        database_path = Path(temporary) / "isolated-fixture.sqlite3"
        connection = sqlite3.connect(database_path)
        try:
            with connection:
                connection.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, amount REAL NOT NULL, legacy_label TEXT NOT NULL)")
                connection.executemany("INSERT INTO orders(id, amount, legacy_label) VALUES (?, ?, ?)", fixture)
            original = legacy_rows(connection)
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("ALTER TABLE orders ADD COLUMN amount_cents INTEGER")
                connection.execute("CREATE TABLE migration_checkpoint (id INTEGER PRIMARY KEY CHECK(id = 1), last_id INTEGER NOT NULL, phase TEXT NOT NULL)")
                connection.execute("INSERT INTO migration_checkpoint VALUES (1, 0, 'expanded')")
            case.assertEqual(legacy_rows(connection), original, "Compatible expansion must preserve old reads and columns")
            # The old insert contract remains accepted before writer coordination.
            with connection:
                connection.execute("INSERT INTO orders(id, amount, legacy_label) VALUES (1001, 7.89, 'synthetic-legacy-insert')")
            expected_legacy = legacy_rows(connection)
            original_hash = fingerprint(expected_legacy)
            case.assertEqual(len(expected_legacy), 98)
            with case.assertRaisesRegex(ValueError, "cutover blocked"):
                validate_ready(connection)

            case.assertEqual(backfill_batch(connection), 17)
            checkpoint_before = connection.execute("SELECT * FROM migration_checkpoint").fetchall()
            rows_before = connection.execute("SELECT * FROM orders ORDER BY id").fetchall()
            with case.assertRaises(InjectedFailure):
                backfill_batch(connection, fail_after=7)
            case.assertEqual(connection.execute("SELECT * FROM orders ORDER BY id").fetchall(), rows_before,
                             "An injected failure must undo every write from that batch")
            case.assertEqual(connection.execute("SELECT * FROM migration_checkpoint").fetchall(), checkpoint_before,
                             "Failure must not advance the resume checkpoint")
            case.assertEqual(connection.execute("SELECT COUNT(*) FROM orders WHERE amount_cents IS NOT NULL").fetchone()[0], 17,
                             "Previously committed batches must survive the failed later batch")

            batch_sizes = [17]
            for _ in range(len(expected_legacy) + 1):
                count = backfill_batch(connection)
                if count == 0:
                    break
                batch_sizes.append(count)
            else:
                case.fail("Rehearsal exceeded bounded backfill iterations")
            case.assertTrue(all(0 < count <= 17 for count in batch_sizes))
            case.assertEqual(sum(batch_sizes), len(expected_legacy))
            case.assertEqual(validate_ready(connection), 98)
            case.assertEqual(fingerprint(legacy_rows(connection)), original_hash)
            expected_total = sum(exact_fixture_cents(row[1]) for row in expected_legacy)
            case.assertEqual(connection.execute("SELECT SUM(amount_cents) FROM orders").fetchone()[0], expected_total)
            migrated_rows = connection.execute("SELECT * FROM orders ORDER BY id").fetchall()
            case.assertEqual(backfill_batch(connection), 0, "Replaying a completed backfill must be idempotent")
            case.assertEqual(connection.execute("SELECT * FROM orders ORDER BY id").fetchall(), migrated_rows)

            # Negative control: an uncoordinated legacy writer after backfill
            # creates drift. The cutover guard must reject it, not quietly pass.
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("UPDATE orders SET amount = amount + 1 WHERE id = 1")
            with case.assertRaisesRegex(ValueError, "cutover blocked"):
                validate_ready(connection)
            connection.rollback()
            case.assertEqual(validate_ready(connection), 98)
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("INSERT INTO orders(id, amount, legacy_label) VALUES (2001, 9.99, 'synthetic-late-writer')")
            with case.assertRaisesRegex(ValueError, "cutover blocked"):
                validate_ready(connection)
            connection.rollback()

            with case.assertRaises(InjectedFailure):
                activate_new_reader(connection, inject_failure=True)
            case.assertIsNone(connection.execute("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'current_orders'").fetchone(),
                              "Failed activation must roll back the new read view")
            case.assertEqual(connection.execute("SELECT phase FROM migration_checkpoint").fetchone()[0], "expanded")
            case.assertEqual(connection.execute("SELECT * FROM orders ORDER BY id").fetchall(), migrated_rows)
            activate_new_reader(connection)
            case.assertEqual(connection.execute("SELECT COUNT(*) FROM current_orders").fetchone()[0], 98)
            case.assertEqual(connection.execute("SELECT phase FROM migration_checkpoint").fetchone()[0], "read-new")
            case.assertEqual(fingerprint(legacy_rows(connection)), original_hash, "The old reader is still usable after activation")
            case.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

            for invalid in [1.005, float("nan"), float("inf"), 1e30]:
                with case.assertRaises(ValueError):
                    exact_fixture_cents(invalid)
            for invalid in [0, 101, True]:
                with case.assertRaises(ValueError):
                    backfill_batch(connection, batch_size=invalid)
            report = {
                "success": True,
                "mode": "synthetic-isolated-sqlite-rehearsal",
                "rows": len(expected_legacy),
                "committedBatches": len(batch_sizes),
                "maxBatchRows": max(batch_sizes),
                "injectedFailuresRolledBack": 2,
                "uncoordinatedWriterCasesRejected": 2,
                "idempotentResume": True,
                "legacyContractPreserved": True,
                "productionDatabaseTouched": False,
                "limitations": "SQLite fixture only; no production DDL, writer concurrency, replication, lock-time/SLA or financial conversion policy is certified.",
            }
        finally:
            connection.close()
    case.assertFalse(database_path.exists(), "Only this newly created temporary fixture must be cleaned up")
    report["temporaryDatabaseRemoved"] = True
    return report


if __name__ == "__main__":
    print(json.dumps(run_rehearsal(), ensure_ascii=True))
