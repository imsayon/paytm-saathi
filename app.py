from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import sqlite3
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SAATHI_DB", ROOT / "data" / "saathi.db"))
FIXTURE_PATH = ROOT / "data" / "fixtures" / "saathi-demo.csv"
MERCHANT_ID = "merchant-demo"
POLICY_VERSION = "retention-v1"
MAX_IMPORT_BYTES = 2_000_000
MAX_ROWS = 5_000


class AppError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, details: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def connect_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def init_db() -> None:
    with connect_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS merchants (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                timezone TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_batches (
                id TEXT PRIMARY KEY,
                merchant_id TEXT NOT NULL REFERENCES merchants(id),
                checksum TEXT NOT NULL,
                source_name TEXT NOT NULL,
                as_of TEXT NOT NULL,
                row_count INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE (merchant_id, checksum)
            );
            CREATE TABLE IF NOT EXISTS customers (
                id TEXT PRIMARY KEY,
                merchant_id TEXT NOT NULL REFERENCES merchants(id),
                external_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                contact_ref TEXT,
                UNIQUE (merchant_id, external_id)
            );
            CREATE TABLE IF NOT EXISTS consents (
                merchant_id TEXT NOT NULL REFERENCES merchants(id),
                customer_id TEXT NOT NULL REFERENCES customers(id),
                value TEXT NOT NULL CHECK (value IN ('true', 'false', 'unknown')),
                source TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                PRIMARY KEY (merchant_id, customer_id)
            );
            CREATE TABLE IF NOT EXISTS payments (
                id TEXT PRIMARY KEY,
                merchant_id TEXT NOT NULL REFERENCES merchants(id),
                payment_id TEXT NOT NULL,
                customer_id TEXT NOT NULL REFERENCES customers(id),
                paid_at TEXT NOT NULL,
                amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
                status TEXT NOT NULL CHECK (status IN ('settled', 'refunded', 'duplicate')),
                import_batch_id TEXT NOT NULL REFERENCES import_batches(id),
                UNIQUE (merchant_id, payment_id)
            );
            CREATE TABLE IF NOT EXISTS campaigns (
                id TEXT PRIMARY KEY,
                merchant_id TEXT NOT NULL REFERENCES merchants(id),
                intent TEXT NOT NULL,
                status TEXT NOT NULL,
                current_version INTEGER NOT NULL,
                as_of TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS campaign_versions (
                id TEXT PRIMARY KEY,
                campaign_id TEXT NOT NULL REFERENCES campaigns(id),
                version INTEGER NOT NULL,
                proposal_json TEXT NOT NULL,
                rules_json TEXT NOT NULL,
                cohort_hash TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE (campaign_id, version)
            );
            CREATE TABLE IF NOT EXISTS recipients (
                id TEXT PRIMARY KEY,
                version_id TEXT NOT NULL REFERENCES campaign_versions(id),
                customer_id TEXT NOT NULL REFERENCES customers(id),
                group_name TEXT NOT NULL CHECK (group_name IN ('campaign', 'holdout')),
                assignment_index INTEGER NOT NULL,
                reason TEXT NOT NULL,
                reward_amount_minor INTEGER NOT NULL,
                UNIQUE (version_id, customer_id)
            );
            CREATE TABLE IF NOT EXISTS approvals (
                id TEXT PRIMARY KEY,
                merchant_id TEXT NOT NULL REFERENCES merchants(id),
                campaign_id TEXT NOT NULL REFERENCES campaigns(id),
                version_id TEXT NOT NULL REFERENCES campaign_versions(id),
                idempotency_key TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE (merchant_id, idempotency_key)
            );
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                version_id TEXT NOT NULL REFERENCES campaign_versions(id),
                recipient_id TEXT NOT NULL REFERENCES recipients(id),
                status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'delivered', 'failed', 'unknown', 'cancelled')),
                provider_key TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                UNIQUE (version_id, recipient_id)
            );
            CREATE TABLE IF NOT EXISTS outcomes (
                id TEXT PRIMARY KEY,
                version_id TEXT NOT NULL REFERENCES campaign_versions(id),
                recipient_id TEXT NOT NULL REFERENCES recipients(id),
                returned_at TEXT NOT NULL,
                amount_minor INTEGER NOT NULL,
                reward_cost_minor INTEGER NOT NULL,
                UNIQUE (version_id, recipient_id)
            );
            CREATE TABLE IF NOT EXISTS audits (
                id TEXT PRIMARY KEY,
                merchant_id TEXT NOT NULL REFERENCES merchants(id),
                campaign_id TEXT,
                event TEXT NOT NULL,
                detail_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS payments_customer_date ON payments(merchant_id, customer_id, paid_at);
            CREATE INDEX IF NOT EXISTS jobs_version_status ON jobs(version_id, status);
            CREATE INDEX IF NOT EXISTS audits_campaign_time ON audits(campaign_id, created_at);
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO merchants (id, name, timezone, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (MERCHANT_ID, "Kaveri Corner Café", "Asia/Kolkata", now_iso()),
        )


def minor_units(value: str) -> int:
    try:
        amount = Decimal(value.strip()).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, AttributeError):
        raise AppError("invalid_amount", "Amount must be a positive number with up to two decimals.", 422)
    if amount <= 0:
        raise AppError("invalid_amount", "Amount must be positive.", 422)
    return int(amount * 100)


def parse_csv(text: str) -> tuple[list[dict[str, Any]], str]:
    if len(text.encode("utf-8")) > MAX_IMPORT_BYTES:
        raise AppError("file_too_large", "CSV files are limited to 2 MB.", 422)
    reader = csv.DictReader(io.StringIO(text))
    required = {"merchant_id", "customer_id", "customer_name", "paid_at", "amount", "status", "consent", "contact_ref"}
    if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
        missing = sorted(required - set(reader.fieldnames or []))
        raise AppError("invalid_headers", "CSV is missing required columns.", 422, {"missing": missing})

    rows: list[dict[str, Any]] = []
    seen_payment_ids: set[str] = set()
    allowed_statuses = {"settled", "refunded", "duplicate"}
    allowed_consent = {"true", "false", "unknown"}
    for line_no, raw in enumerate(reader, start=2):
        if len(rows) >= MAX_ROWS:
            raise AppError("too_many_rows", f"CSV files are limited to {MAX_ROWS} rows.", 422)
        try:
            merchant_id = (raw.get("merchant_id") or "").strip()
            customer_id = (raw.get("customer_id") or "").strip()
            customer_name = (raw.get("customer_name") or "").strip()
            paid_at = date.fromisoformat((raw.get("paid_at") or "").strip()).isoformat()
            status = (raw.get("status") or "").strip().lower()
            consent = (raw.get("consent") or "").strip().lower()
            contact_ref = (raw.get("contact_ref") or "").strip() or None
            if merchant_id != MERCHANT_ID:
                raise ValueError("merchant_id must be merchant-demo")
            if not customer_id or len(customer_id) > 100:
                raise ValueError("customer_id is required and must be at most 100 characters")
            if not customer_name or len(customer_name) > 120:
                raise ValueError("customer_name is required and must be at most 120 characters")
            if status not in allowed_statuses:
                raise ValueError("status must be settled, refunded, or duplicate")
            if consent not in allowed_consent:
                raise ValueError("consent must be true, false, or unknown")
            if contact_ref and len(contact_ref) > 200:
                raise ValueError("contact_ref is too long")
            amount_minor = minor_units(raw.get("amount") or "")
            payment_id = (raw.get("payment_id") or "").strip()
            if not payment_id:
                payment_id = "derived_" + hashlib.sha256(
                    f"{merchant_id}|{customer_id}|{paid_at}|{amount_minor}".encode()
                ).hexdigest()[:20]
            if payment_id in seen_payment_ids:
                raise ValueError("payment_id is duplicated in the file")
            seen_payment_ids.add(payment_id)
        except AppError:
            raise
        except (ValueError, TypeError) as exc:
            raise AppError("invalid_row", f"Row {line_no}: {exc}", 422, {"row": line_no}) from exc
        rows.append(
            {
                "merchant_id": merchant_id,
                "customer_id": customer_id,
                "customer_name": customer_name,
                "paid_at": paid_at,
                "amount_minor": amount_minor,
                "status": status,
                "consent": consent,
                "contact_ref": contact_ref,
                "payment_id": payment_id,
            }
        )
    if not rows:
        raise AppError("empty_file", "CSV must contain at least one payment row.", 422)
    return rows, hashlib.sha256(text.encode("utf-8")).hexdigest()


def add_audit(
    conn: sqlite3.Connection,
    event: str,
    detail: dict[str, Any],
    campaign_id: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO audits (id, merchant_id, campaign_id, event, detail_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (new_id("audit"), MERCHANT_ID, campaign_id, event, json.dumps(detail, ensure_ascii=False), now_iso()),
    )


def import_csv(text: str, source_name: str, as_of: str = "2026-09-01") -> dict[str, Any]:
    rows, checksum = parse_csv(text)
    try:
        as_of_date = date.fromisoformat(as_of)
    except ValueError as exc:
        raise AppError("invalid_as_of", "as_of must be an ISO date.", 422) from exc
    with connect_db() as conn:
        existing = conn.execute(
            "SELECT id FROM import_batches WHERE merchant_id = ? AND checksum = ?",
            (MERCHANT_ID, checksum),
        ).fetchone()
        if existing:
            return {"duplicate": True, "batch_id": existing["id"], **overview(conn)}

        payment_ids = [row["payment_id"] for row in rows]
        placeholders = ",".join("?" for _ in payment_ids)
        collision = conn.execute(
            f"SELECT payment_id FROM payments WHERE merchant_id = ? AND payment_id IN ({placeholders}) LIMIT 1",
            [MERCHANT_ID, *payment_ids],
        ).fetchone()
        if collision:
            raise AppError(
                "payment_conflict",
                "This file contains a payment ID already imported from another batch.",
                409,
                {"payment_id": collision["payment_id"]},
            )

        batch_id = new_id("batch")
        conn.execute(
            """
            INSERT INTO import_batches (id, merchant_id, checksum, source_name, as_of, row_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (batch_id, MERCHANT_ID, checksum, source_name[:160], as_of_date.isoformat(), len(rows), now_iso()),
        )
        customers: dict[str, str] = {}
        for row in rows:
            customer_db_id = customers.get(row["customer_id"])
            if not customer_db_id:
                customer_db_id = "customer_" + hashlib.sha256(
                    f"{MERCHANT_ID}|{row['customer_id']}".encode()
                ).hexdigest()[:18]
                customers[row["customer_id"]] = customer_db_id
                conn.execute(
                    """
                    INSERT INTO customers (id, merchant_id, external_id, display_name, contact_ref)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (merchant_id, external_id) DO UPDATE SET
                      display_name = excluded.display_name,
                      contact_ref = excluded.contact_ref
                    """,
                    (
                        customer_db_id,
                        MERCHANT_ID,
                        row["customer_id"],
                        row["customer_name"],
                        row["contact_ref"],
                    ),
                )
                conn.execute(
                    """
                    INSERT INTO consents (merchant_id, customer_id, value, source, observed_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (merchant_id, customer_id) DO UPDATE SET
                      value = excluded.value,
                      source = excluded.source,
                      observed_at = excluded.observed_at
                    """,
                    (MERCHANT_ID, customer_db_id, row["consent"], "synthetic-import", now_iso()),
                )
            conn.execute(
                """
                INSERT INTO payments
                  (id, merchant_id, payment_id, customer_id, paid_at, amount_minor, status, import_batch_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id("payment"),
                    MERCHANT_ID,
                    row["payment_id"],
                    customer_db_id,
                    row["paid_at"],
                    row["amount_minor"],
                    row["status"],
                    batch_id,
                ),
            )
        add_audit(conn, "import.completed", {"batch_id": batch_id, "rows": len(rows), "source": source_name})
        return {"duplicate": False, "batch_id": batch_id, **overview(conn)}


def latest_import(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM import_batches WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 1",
        (MERCHANT_ID,),
    ).fetchone()


def mask_customer(external_id: str) -> str:
    return f"…{external_id[-4:]}"


def signal_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    batch = latest_import(conn)
    if not batch:
        return {
            "ready": False,
            "as_of": None,
            "regular_absent_count": 0,
            "eligible_count": 0,
            "excluded": {"consent_false": 0, "consent_unknown": 0, "no_contact_ref": 0},
            "eligible_customers": [],
            "excluded_customers": [],
            "active_regular_count": 0,
            "cohort_hash": None,
        }

    as_of = date.fromisoformat(batch["as_of"])
    start = as_of - timedelta(days=60)
    absent_cutoff = as_of - timedelta(days=21)
    customers = conn.execute(
        """
        SELECT c.id, c.external_id, c.display_name, c.contact_ref, co.value AS consent
        FROM customers c
        LEFT JOIN consents co ON co.customer_id = c.id AND co.merchant_id = c.merchant_id
        WHERE c.merchant_id = ?
        ORDER BY c.external_id
        """,
        (MERCHANT_ID,),
    ).fetchall()
    payments = conn.execute(
        """
        SELECT customer_id, paid_at, amount_minor, status
        FROM payments
        WHERE merchant_id = ? AND paid_at <= ?
        ORDER BY paid_at
        """,
        (MERCHANT_ID, as_of.isoformat()),
    ).fetchall()
    by_customer: dict[str, list[sqlite3.Row]] = {}
    for payment in payments:
        by_customer.setdefault(payment["customer_id"], []).append(payment)

    absent_regular: list[dict[str, Any]] = []
    active_regular_count = 0
    for customer in customers:
        settled = [
            payment
            for payment in by_customer.get(customer["id"], [])
            if payment["status"] == "settled"
            and start.isoformat() <= payment["paid_at"] <= as_of.isoformat()
        ]
        if len(settled) < 3 or len({payment["paid_at"] for payment in settled}) < 2:
            continue
        last_visit = max(payment["paid_at"] for payment in settled)
        customer_info = {
            "id": customer["id"],
            "external_id": customer["external_id"],
            "masked_id": mask_customer(customer["external_id"]),
            "display_name": customer["display_name"],
            "consent": customer["consent"] or "unknown",
            "last_visit": last_visit,
            "visits": len(settled),
        }
        if last_visit > absent_cutoff.isoformat():
            active_regular_count += 1
        else:
            absent_regular.append(customer_info)

    excluded: dict[str, int] = {"consent_false": 0, "consent_unknown": 0, "no_contact_ref": 0}
    eligible: list[dict[str, Any]] = []
    excluded_customers: list[dict[str, Any]] = []
    for customer_info in absent_regular:
        customer = next(item for item in customers if item["id"] == customer_info["id"])
        reason = None
        if customer_info["consent"] == "false":
            reason = "consent_false"
        elif customer_info["consent"] == "unknown":
            reason = "consent_unknown"
        elif not customer["contact_ref"]:
            reason = "no_contact_ref"
        if reason:
            excluded[reason] += 1
            excluded_customers.append({**customer_info, "reason": reason})
        else:
            eligible.append(customer_info)

    cohort_hash = hashlib.sha256(
        json.dumps([customer["id"] for customer in eligible], separators=(",", ":")).encode()
    ).hexdigest()
    return {
        "ready": True,
        "as_of": batch["as_of"],
        "regular_absent_count": len(absent_regular),
        "eligible_count": len(eligible),
        "excluded": excluded,
        "eligible_customers": eligible,
        "excluded_customers": excluded_customers,
        "active_regular_count": active_regular_count,
        "cohort_hash": cohort_hash,
    }


def default_reward(cap_minor: int, eligible_count: int) -> int:
    return max(100, min(1500, cap_minor // max(eligible_count, 1)))


def template_proposal(intent: str, eligible_count: int, cap_minor: int, reward_minor: int) -> dict[str, Any]:
    return {
        "audience_label": "Weekday regulars absent for 21+ days",
        "offer": {
            "kind": "fixed_reward",
            "amount_minor": reward_minor,
            "valid_days": 7,
            "weekday_only": True,
        },
        "timing": {"local_start": "11:00", "local_end": "16:00"},
        "rationale": [
            "Targets customers with a repeat-visit pattern before the 21-day gap.",
            "Consent and contactability are checked by deterministic rules.",
            "A holdout group keeps the outcome comparison honest.",
        ],
        "copy": {
            "headline": "We saved a little something for your next weekday visit",
            "body": "Come by this week and enjoy a reward on your next weekday visit.",
            "cta": "Visit this week",
        },
        "estimated_cost_minor": eligible_count * reward_minor,
        "exclusions": ["Refunded or duplicate payments", "Consent false or unknown"],
        "intent": intent,
    }


def openai_proposal(
    intent: str,
    signal: dict[str, Any],
    cap_minor: int,
    reward_minor: int,
) -> tuple[dict[str, Any], str]:
    template = template_proposal(intent, signal["eligible_count"], cap_minor, reward_minor)
    api_key = os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("OPENAI_MODEL")
    if not api_key or not model:
        return template, "template-fallback"

    payload = {
        "model": model,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": (
                    "You draft one concise merchant retention proposal as JSON. "
                    "Never select customer IDs, change consent, change the budget, claim delivery, "
                    "or request tools. Use exactly the supplied fixed_reward amount and valid days. "
                    "Return keys: audience_label, rationale (array of strings), copy "
                    "(headline, body, cta), timing (local_start, local_end)."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "merchant_intent_untrusted": intent,
                        "eligible_count": signal["eligible_count"],
                        "excluded_counts": signal["excluded"],
                        "budget_cap_minor": cap_minor,
                        "fixed_reward_minor": reward_minor,
                        "policy_version": POLICY_VERSION,
                    },
                    ensure_ascii=False,
                ),
            },
        ],
    }
    request = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            response_json = json.loads(response.read().decode())
        content = response_json["choices"][0]["message"]["content"]
        generated = json.loads(content)
        proposal = {
            **template,
            "audience_label": str(generated.get("audience_label") or template["audience_label"])[:120],
            "rationale": [str(item)[:180] for item in generated.get("rationale", [])[:4]],
            "copy": {
                "headline": str(generated.get("copy", {}).get("headline") or template["copy"]["headline"])[:120],
                "body": str(generated.get("copy", {}).get("body") or template["copy"]["body"])[:280],
                "cta": str(generated.get("copy", {}).get("cta") or template["copy"]["cta"])[:60],
            },
            "timing": {
                "local_start": str(generated.get("timing", {}).get("local_start") or "11:00")[:5],
                "local_end": str(generated.get("timing", {}).get("local_end") or "16:00")[:5],
            },
        }
        return proposal, "openai"
    except (urllib.error.URLError, TimeoutError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return template, "template-fallback"


def evaluate_proposal(proposal: dict[str, Any], eligible_count: int, cap_minor: int) -> dict[str, Any]:
    errors: list[str] = []
    warnings = ["Contribution is a payment-volume proxy; margin and support costs are unavailable."]
    offer = proposal.get("offer") or {}
    reward = offer.get("amount_minor")
    valid_days = offer.get("valid_days")
    if not isinstance(reward, int) or reward <= 0 or reward > 5000:
        errors.append("Reward must be an integer between ₹1 and ₹50 per recipient.")
        reward = 0
    if not isinstance(valid_days, int) or not 1 <= valid_days <= 30:
        errors.append("Offer validity must be between 1 and 30 days.")
    estimated_cost = eligible_count * reward
    if estimated_cost > cap_minor:
        errors.append(
            f"Estimated reward exposure is ₹{estimated_cost / 100:.0f}, above the ₹{cap_minor / 100:.0f} cap."
        )
    if eligible_count == 0:
        errors.append("There are no contactable eligible customers.")
    return {
        "valid": not errors,
        "audience_count": eligible_count,
        "estimated_cost_minor": estimated_cost,
        "budget_cap_minor": cap_minor,
        "errors": errors,
        "warnings": warnings,
        "policy_version": POLICY_VERSION,
    }


def create_version(
    conn: sqlite3.Connection,
    campaign_id: str,
    version_number: int,
    proposal: dict[str, Any],
    rules: dict[str, Any],
    source: str,
    signal: dict[str, Any],
) -> str:
    version_id = new_id("version")
    conn.execute(
        """
        INSERT INTO campaign_versions
          (id, campaign_id, version, proposal_json, rules_json, cohort_hash, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            version_id,
            campaign_id,
            version_number,
            json.dumps(proposal, ensure_ascii=False),
            json.dumps(rules, ensure_ascii=False),
            signal["cohort_hash"],
            source,
            now_iso(),
        ),
    )
    ordered = sorted(
        signal["eligible_customers"],
        key=lambda customer: hashlib.sha256(f"{campaign_id}:{customer['id']}".encode()).hexdigest(),
    )
    campaign_count = (len(ordered) + 1) // 2
    for index, customer in enumerate(ordered):
        conn.execute(
            """
            INSERT INTO recipients
              (id, version_id, customer_id, group_name, assignment_index, reason, reward_amount_minor)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                new_id("recipient"),
                version_id,
                customer["id"],
                "campaign" if index < campaign_count else "holdout",
                index,
                "previously regular; absent for at least 21 days; consent=true",
                proposal["offer"]["amount_minor"],
            ),
        )
    return version_id


def create_campaign(intent: str, cap_minor: int, reward_minor: int | None = None) -> dict[str, Any]:
    with connect_db() as conn:
        signal = signal_summary(conn)
        if not signal["ready"]:
            raise AppError("import_required", "Load a payment CSV before creating a campaign.", 409)
        if signal["eligible_count"] == 0:
            raise AppError("no_eligible_cohort", "No contactable eligible customers were found.", 422)
        reward = reward_minor or default_reward(cap_minor, signal["eligible_count"])
        proposal, source = openai_proposal(intent, signal, cap_minor, reward)
        proposal["offer"]["amount_minor"] = reward
        proposal["estimated_cost_minor"] = signal["eligible_count"] * reward
        rules = evaluate_proposal(proposal, signal["eligible_count"], cap_minor)
        campaign_id = new_id("campaign")
        conn.execute(
            """
            INSERT INTO campaigns
              (id, merchant_id, intent, status, current_version, as_of, created_at, updated_at)
            VALUES (?, ?, ?, 'review', 1, ?, ?, ?)
            """,
            (campaign_id, MERCHANT_ID, intent[:500], signal["as_of"], now_iso(), now_iso()),
        )
        create_version(conn, campaign_id, 1, proposal, rules, source, signal)
        add_audit(
            conn,
            "campaign.previewed",
            {"source": source, "version": 1, "rules_valid": rules["valid"], "cohort": signal["eligible_count"]},
            campaign_id,
        )
        return campaign_json(conn, campaign_id)


def campaign_json(conn: sqlite3.Connection, campaign_id: str) -> dict[str, Any]:
    campaign = conn.execute(
        "SELECT * FROM campaigns WHERE id = ? AND merchant_id = ?",
        (campaign_id, MERCHANT_ID),
    ).fetchone()
    if not campaign:
        raise AppError("not_found", "Campaign not found.", 404)
    version = conn.execute(
        """
        SELECT * FROM campaign_versions
        WHERE campaign_id = ? AND version = ?
        """,
        (campaign_id, campaign["current_version"]),
    ).fetchone()
    proposal = json.loads(version["proposal_json"])
    rules = json.loads(version["rules_json"])
    recipients = conn.execute(
        """
        SELECT r.id, r.group_name, r.assignment_index, r.reason, r.reward_amount_minor,
               c.external_id, c.display_name
        FROM recipients r
        JOIN customers c ON c.id = r.customer_id
        WHERE r.version_id = ?
        ORDER BY r.assignment_index
        """,
        (version["id"],),
    ).fetchall()
    jobs = conn.execute(
        """
        SELECT j.id, j.status, j.provider_key, j.attempts, j.updated_at,
               r.group_name, c.external_id
        FROM jobs j
        JOIN recipients r ON r.id = j.recipient_id
        JOIN customers c ON c.id = r.customer_id
        WHERE j.version_id = ?
        ORDER BY j.id
        """,
        (version["id"],),
    ).fetchall()
    audits = conn.execute(
        "SELECT event, detail_json, created_at FROM audits WHERE campaign_id = ? ORDER BY created_at",
        (campaign_id,),
    ).fetchall()
    return {
        "id": campaign["id"],
        "intent": campaign["intent"],
        "status": campaign["status"],
        "current_version": campaign["current_version"],
        "as_of": campaign["as_of"],
        "version": {
            "id": version["id"],
            "number": version["version"],
            "source": version["source"],
            "proposal": proposal,
            "rules": rules,
            "cohort_hash": version["cohort_hash"],
            "created_at": version["created_at"],
        },
        "recipients": [
            {
                "id": row["id"],
                "group": row["group_name"],
                "assignment_index": row["assignment_index"],
                "masked_id": mask_customer(row["external_id"]),
                "display_name": row["display_name"],
                "reason": row["reason"],
                "reward_amount_minor": row["reward_amount_minor"],
            }
            for row in recipients
        ],
        "jobs": [dict(row) for row in jobs],
        "audits": [
            {"event": row["event"], "detail": json.loads(row["detail_json"]), "created_at": row["created_at"]}
            for row in audits
        ],
    }


def revise_campaign(
    campaign_id: str,
    version_number: int,
    reward_minor: int,
    headline: str,
    body: str,
    cta: str,
) -> dict[str, Any]:
    with connect_db() as conn:
        campaign = conn.execute(
            "SELECT * FROM campaigns WHERE id = ? AND merchant_id = ?",
            (campaign_id, MERCHANT_ID),
        ).fetchone()
        if not campaign:
            raise AppError("not_found", "Campaign not found.", 404)
        if campaign["current_version"] != version_number:
            raise AppError("stale_version", "This review is out of date.", 409)
        if campaign["status"] not in {"review"}:
            raise AppError("campaign_locked", "Only a campaign in review can be edited.", 409)
        current = conn.execute(
            "SELECT * FROM campaign_versions WHERE campaign_id = ? AND version = ?",
            (campaign_id, version_number),
        ).fetchone()
        proposal = json.loads(current["proposal_json"])
        proposal["offer"]["amount_minor"] = reward_minor
        proposal["copy"] = {
            "headline": headline.strip()[:120],
            "body": body.strip()[:280],
            "cta": cta.strip()[:60],
        }
        signal = signal_summary(conn)
        rules = evaluate_proposal(proposal, signal["eligible_count"], current_rules_cap(current))
        new_version = version_number + 1
        create_version(conn, campaign_id, new_version, proposal, rules, "merchant-edited", signal)
        conn.execute(
            "UPDATE campaigns SET current_version = ?, updated_at = ? WHERE id = ?",
            (new_version, now_iso(), campaign_id),
        )
        add_audit(
            conn,
            "campaign.revised",
            {"from_version": version_number, "to_version": new_version, "rules_valid": rules["valid"]},
            campaign_id,
        )
        return campaign_json(conn, campaign_id)


def current_rules_cap(version: sqlite3.Row) -> int:
    return int(json.loads(version["rules_json"])["budget_cap_minor"])


def approve_campaign(campaign_id: str, version_number: int, idempotency_key: str) -> dict[str, Any]:
    if not idempotency_key or len(idempotency_key) > 120:
        raise AppError("idempotency_required", "Approval requires an Idempotency-Key header.", 400)
    conn = connect_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            """
            SELECT * FROM approvals
            WHERE merchant_id = ? AND idempotency_key = ?
            """,
            (MERCHANT_ID, idempotency_key),
        ).fetchone()
        if existing:
            if existing["version_id"] != conn.execute(
                "SELECT id FROM campaign_versions WHERE campaign_id = ? AND version = ?",
                (campaign_id, version_number),
            ).fetchone()["id"]:
                raise AppError("idempotency_conflict", "This idempotency key belongs to another approval.", 409)
            conn.commit()
            return campaign_json(conn, campaign_id)

        campaign = conn.execute(
            "SELECT * FROM campaigns WHERE id = ? AND merchant_id = ?",
            (campaign_id, MERCHANT_ID),
        ).fetchone()
        if not campaign:
            raise AppError("not_found", "Campaign not found.", 404)
        if campaign["status"] != "review" or campaign["current_version"] != version_number:
            raise AppError("stale_version", "Only the current reviewed version can be approved.", 409)
        version = conn.execute(
            "SELECT * FROM campaign_versions WHERE campaign_id = ? AND version = ?",
            (campaign_id, version_number),
        ).fetchone()
        rules = json.loads(version["rules_json"])
        if not rules["valid"]:
            raise AppError("rules_failed", "Approval is blocked until every rule passes.", 422, {"rules": rules})
        approval_id = new_id("approval")
        conn.execute(
            """
            INSERT INTO approvals
              (id, merchant_id, campaign_id, version_id, idempotency_key, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (approval_id, MERCHANT_ID, campaign_id, version["id"], idempotency_key, now_iso()),
        )
        recipients = conn.execute(
            "SELECT id FROM recipients WHERE version_id = ?",
            (version["id"],),
        ).fetchall()
        for recipient in recipients:
            conn.execute(
                """
                INSERT INTO jobs
                  (id, version_id, recipient_id, status, provider_key, attempts, updated_at)
                VALUES (?, ?, ?, 'queued', ?, 0, ?)
                """,
                (
                    new_id("job"),
                    version["id"],
                    recipient["id"],
                    f"mock:{campaign_id}:{version_number}:{recipient['id']}",
                    now_iso(),
                ),
            )
        conn.execute(
            "UPDATE campaigns SET status = 'queued', updated_at = ? WHERE id = ?",
            (now_iso(), campaign_id),
        )
        add_audit(
            conn,
            "campaign.approved",
            {"approval_id": approval_id, "version": version_number, "jobs_queued": len(recipients)},
            campaign_id,
        )
        conn.commit()
        return campaign_json(conn, campaign_id)
    except AppError:
        conn.rollback()
        raise
    except sqlite3.IntegrityError as exc:
        conn.rollback()
        raise AppError("approval_conflict", "This campaign was approved by another request.", 409) from exc
    finally:
        conn.close()


def run_delivery(campaign_id: str) -> dict[str, Any]:
    with connect_db() as conn:
        campaign = conn.execute(
            "SELECT * FROM campaigns WHERE id = ? AND merchant_id = ?",
            (campaign_id, MERCHANT_ID),
        ).fetchone()
        if not campaign:
            raise AppError("not_found", "Campaign not found.", 404)
        if campaign["status"] not in {"queued", "delivering", "outcome_window"}:
            if campaign["status"] == "reported":
                return campaign_json(conn, campaign_id)
            raise AppError("delivery_not_ready", "Approve the campaign before running mock delivery.", 409)
        version = conn.execute(
            "SELECT id FROM campaign_versions WHERE campaign_id = ? AND version = ?",
            (campaign_id, campaign["current_version"]),
        ).fetchone()
        jobs = conn.execute(
            "SELECT id FROM jobs WHERE version_id = ? AND status IN ('queued', 'processing')",
            (version["id"],),
        ).fetchall()
        for job in jobs:
            conn.execute(
                "UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?",
                (now_iso(), job["id"]),
            )
            conn.execute(
                "UPDATE jobs SET status = 'delivered', updated_at = ? WHERE id = ?",
                (now_iso(), job["id"]),
            )
        conn.execute(
            "UPDATE campaigns SET status = 'outcome_window', updated_at = ? WHERE id = ?",
            (now_iso(), campaign_id),
        )
        add_audit(conn, "delivery.completed", {"delivered": len(jobs), "provider": "mock"}, campaign_id)
        return campaign_json(conn, campaign_id)


def run_outcome(campaign_id: str) -> dict[str, Any]:
    with connect_db() as conn:
        campaign = conn.execute(
            "SELECT * FROM campaigns WHERE id = ? AND merchant_id = ?",
            (campaign_id, MERCHANT_ID),
        ).fetchone()
        if not campaign:
            raise AppError("not_found", "Campaign not found.", 404)
        if campaign["status"] == "reported":
            return report(conn, campaign_id)
        if campaign["status"] != "outcome_window":
            raise AppError("outcome_not_ready", "Run mock delivery before advancing the demo clock.", 409)
        version = conn.execute(
            "SELECT * FROM campaign_versions WHERE campaign_id = ? AND version = ?",
            (campaign_id, campaign["current_version"]),
        ).fetchone()
        jobs = conn.execute(
            "SELECT status FROM jobs WHERE version_id = ?",
            (version["id"],),
        ).fetchall()
        if not jobs or any(job["status"] != "delivered" for job in jobs):
            raise AppError("delivery_incomplete", "The seven-day window opens after delivery is complete.", 409)
        recipients = conn.execute(
            """
            SELECT * FROM recipients
            WHERE version_id = ?
            ORDER BY group_name, assignment_index
            """,
            (version["id"],),
        ).fetchall()
        campaign_index = 0
        holdout_index = 0
        for recipient in recipients:
            if recipient["group_name"] == "campaign":
                returned = campaign_index < 6
                campaign_index += 1
            else:
                returned = holdout_index < 2
                holdout_index += 1
            if returned:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO outcomes
                      (id, version_id, recipient_id, returned_at, amount_minor, reward_cost_minor)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        new_id("outcome"),
                        version["id"],
                        recipient["id"],
                        "2026-09-04",
                        18000,
                        recipient["reward_amount_minor"] if recipient["group_name"] == "campaign" else 0,
                    ),
                )
        conn.execute(
            "UPDATE campaigns SET status = 'reported', updated_at = ? WHERE id = ?",
            (now_iso(), campaign_id),
        )
        add_audit(
            conn,
            "outcome.reported",
            {"window_days": 7, "simulator": True, "campaign_returns": 6, "holdout_returns": 2},
            campaign_id,
        )
        return report(conn, campaign_id)


def report(conn: sqlite3.Connection, campaign_id: str) -> dict[str, Any]:
    campaign = conn.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
    version = conn.execute(
        "SELECT * FROM campaign_versions WHERE campaign_id = ? AND version = ?",
        (campaign_id, campaign["current_version"]),
    ).fetchone()
    recipients = conn.execute(
        "SELECT * FROM recipients WHERE version_id = ?",
        (version["id"],),
    ).fetchall()
    outcomes = conn.execute(
        "SELECT * FROM outcomes WHERE version_id = ?",
        (version["id"],),
    ).fetchall()
    group_counts = {"campaign": 0, "holdout": 0}
    returned_counts = {"campaign": 0, "holdout": 0}
    for recipient in recipients:
        group_counts[recipient["group_name"]] += 1
    recipient_groups = {
        row["recipient_id"]: next(item["group_name"] for item in recipients if item["id"] == row["recipient_id"])
        for row in outcomes
    }
    for outcome in outcomes:
        returned_counts[recipient_groups[outcome["recipient_id"]]] += 1
    campaign_rate = returned_counts["campaign"] / group_counts["campaign"] if group_counts["campaign"] else 0
    holdout_rate = returned_counts["holdout"] / group_counts["holdout"] if group_counts["holdout"] else 0
    campaign_volume = sum(row["amount_minor"] for row in outcomes if recipient_groups[row["recipient_id"]] == "campaign")
    holdout_amounts = [row["amount_minor"] for row in outcomes if recipient_groups[row["recipient_id"]] == "holdout"]
    average_return = sum(holdout_amounts) / len(holdout_amounts) if holdout_amounts else 18000
    expected_baseline = holdout_rate * group_counts["campaign"] * average_return
    reward_cost = sum(row["reward_cost_minor"] for row in outcomes if recipient_groups[row["recipient_id"]] == "campaign")
    contribution_proxy = campaign_volume - expected_baseline - reward_cost
    jobs = conn.execute("SELECT status FROM jobs WHERE version_id = ?", (version["id"],)).fetchall()
    errors = sum(1 for row in jobs if row["status"] in {"failed", "unknown"})
    approval = conn.execute(
        "SELECT created_at FROM approvals WHERE campaign_id = ? ORDER BY created_at LIMIT 1",
        (campaign_id,),
    ).fetchone()
    setup_seconds = None
    if approval:
        created = datetime.fromisoformat(campaign["created_at"])
        approved = datetime.fromisoformat(approval["created_at"])
        setup_seconds = max(0, int((approved - created).total_seconds()))
    return {
        "ready": campaign["status"] == "reported",
        "status": campaign["status"],
        "simulated": True,
        "window_days": 7,
        "groups": {
            "campaign": {"size": group_counts["campaign"], "returns": returned_counts["campaign"], "rate": campaign_rate},
            "holdout": {"size": group_counts["holdout"], "returns": returned_counts["holdout"], "rate": holdout_rate},
        },
        "observed_lift_percentage_points": round((campaign_rate - holdout_rate) * 100, 1),
        "expected_incremental_returns": round((campaign_rate - holdout_rate) * group_counts["campaign"], 1),
        "campaign_return_volume_minor": int(campaign_volume),
        "expected_baseline_volume_minor": int(expected_baseline),
        "incremental_payment_volume_minor": int(campaign_volume - expected_baseline),
        "reward_cost_minor": int(reward_cost),
        "contribution_proxy_minor": int(contribution_proxy),
        "delivery_errors": errors,
        "opt_outs": 0,
        "setup_time_seconds": setup_seconds,
        "caveats": [
            "Descriptive synthetic comparison, not proof of causal impact.",
            "Contribution proxy uses payment volume after reward; it is not profit.",
            "No real customer message or money movement occurred.",
        ],
    }


def overview(conn: sqlite3.Connection) -> dict[str, Any]:
    batch = latest_import(conn)
    signal = signal_summary(conn)
    campaign = conn.execute(
        "SELECT id, status, current_version, created_at FROM campaigns WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 1",
        (MERCHANT_ID,),
    ).fetchone()
    return {
        "merchant": {"id": MERCHANT_ID, "name": "Kaveri Corner Café", "timezone": "Asia/Kolkata"},
        "latest_import": dict(batch) if batch else None,
        "signal": signal,
        "latest_campaign": dict(campaign) if campaign else None,
    }


def json_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    if length > MAX_IMPORT_BYTES + 100_000:
        raise AppError("request_too_large", "Request is too large.", 413)
    try:
        raw = handler.rfile.read(length)
        return json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AppError("invalid_json", "Request body must be valid JSON.", 400) from exc


class Handler(BaseHTTPRequestHandler):
    server_version = "Saathi/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_json(self, status: int, value: dict[str, Any]) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def send_error_json(self, error: AppError) -> None:
        self.send_json(
            error.status,
            {
                "error": {
                    "code": error.code,
                    "message": error.message,
                    "details": error.details,
                    "request_id": self.headers.get("X-Request-ID", new_id("request")),
                }
            },
        )

    def do_GET(self) -> None:
        try:
            path = urlsplit(self.path).path
            if path == "/":
                return self.serve_file(ROOT / "static" / "index.html", "text/html; charset=utf-8")
            if path.startswith("/static/"):
                name = path.removeprefix("/static/")
                candidate = (ROOT / "static" / name).resolve()
                if ROOT / "static" not in candidate.parents:
                    raise AppError("not_found", "File not found.", 404)
                content_type = {
                    ".css": "text/css; charset=utf-8",
                    ".js": "text/javascript; charset=utf-8",
                }.get(candidate.suffix, "application/octet-stream")
                return self.serve_file(candidate, content_type)
            if path == "/api/healthz":
                with connect_db() as conn:
                    conn.execute("SELECT 1").fetchone()
                return self.send_json(200, {"ok": True, "database": "ready", "worker": "demo-control"})
            if path == "/api/overview":
                with connect_db() as conn:
                    return self.send_json(200, overview(conn))
            if path.startswith("/api/campaigns/"):
                parts = [part for part in path.split("/") if part]
                if len(parts) == 3 and parts[2] == "outcome":
                    with connect_db() as conn:
                        campaign_id = parts[1]
                        conn.execute("SELECT id FROM campaigns WHERE id = ?", (campaign_id,)).fetchone() or (
                            (_ for _ in ()).throw(AppError("not_found", "Campaign not found.", 404))
                        )
                        return self.send_json(200, report(conn, campaign_id))
                if len(parts) == 2:
                    with connect_db() as conn:
                        return self.send_json(200, campaign_json(conn, parts[1]))
            raise AppError("not_found", "Route not found.", 404)
        except AppError as error:
            self.send_error_json(error)
        except Exception:
            self.send_error_json(AppError("internal_error", "The demo encountered an unexpected error.", 500))

    def do_POST(self) -> None:
        try:
            path = urlsplit(self.path).path
            body = json_body(self)
            if path == "/api/imports":
                if body.get("fixture") == "demo":
                    text = FIXTURE_PATH.read_text(encoding="utf-8")
                    return self.send_json(201, import_csv(text, "saathi-demo.csv", body.get("as_of", "2026-09-01")))
                text = body.get("csv")
                if not isinstance(text, str):
                    raise AppError("csv_required", "Provide csv text or fixture=demo.", 400)
                return self.send_json(
                    201,
                    import_csv(text, str(body.get("source_name") or "uploaded.csv"), str(body.get("as_of") or "2026-09-01")),
                )
            if path == "/api/campaigns/preview":
                intent = str(body.get("intent") or "").strip()
                if not intent or len(intent) > 500:
                    raise AppError("invalid_intent", "Intent is required and must be at most 500 characters.", 422)
                cap_minor = int(body.get("budget_cap_minor") or 0)
                if cap_minor <= 0:
                    raise AppError("invalid_budget", "Budget cap must be a positive integer in paise.", 422)
                reward_minor = body.get("reward_minor")
                reward = int(reward_minor) if reward_minor is not None else None
                return self.send_json(201, create_campaign(intent, cap_minor, reward))
            if path.startswith("/api/campaigns/"):
                parts = [part for part in path.split("/") if part]
                if len(parts) != 4:
                    raise AppError("not_found", "Route not found.", 404)
                campaign_id, action = parts[1], parts[2]
                if action == "revise" and parts[3] == "":
                    pass
                if action == "revise":
                    version = int(body.get("version") or 0)
                    return self.send_json(
                        200,
                        revise_campaign(
                            campaign_id,
                            version,
                            int(body.get("reward_minor") or 0),
                            str(body.get("headline") or ""),
                            str(body.get("body") or ""),
                            str(body.get("cta") or ""),
                        ),
                    )
                if action == "approve":
                    version = int(body.get("version") or 0)
                    result = approve_campaign(
                        campaign_id,
                        version,
                        self.headers.get("Idempotency-Key", ""),
                    )
                    return self.send_json(200, result)
                if action == "demo" and parts[3] == "run-delivery":
                    return self.send_json(200, run_delivery(campaign_id))
                if action == "demo" and parts[3] == "run-outcome":
                    return self.send_json(200, run_outcome(campaign_id))
            raise AppError("not_found", "Route not found.", 404)
        except (ValueError, TypeError) as error:
            self.send_error_json(AppError("invalid_request", "Request fields have the wrong type.", 422))
        except AppError as error:
            self.send_error_json(error)
        except Exception:
            self.send_error_json(AppError("internal_error", "The demo encountered an unexpected error.", 500))

    def serve_file(self, path: Path, content_type: str) -> None:
        if not path.is_file():
            raise AppError("not_found", "File not found.", 404)
        payload = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    init_db()
    host = os.environ.get("SAATHI_HOST", "127.0.0.1")
    port = int(os.environ.get("SAATHI_PORT", "8000"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Paytm Saathi running at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
