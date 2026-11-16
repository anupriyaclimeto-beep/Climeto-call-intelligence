#!/usr/bin/env python3
"""
Send fake Manyreach webhook payloads to local Call Intelligence Workspace.

Usage:
  set MANYREACH_WEBHOOK_SECRET=dev-secret
  python scripts/send_test_manyreach_event.py
  python scripts/send_test_manyreach_event.py --type reply
  python scripts/send_test_manyreach_event.py --type click --email unknown@example.com
  python scripts/send_test_manyreach_event.py --all

Env:
  API_BASE (default http://localhost:4200)
  MANYREACH_WEBHOOK_SECRET (required)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from uuid import uuid4


API_BASE = os.environ.get("API_BASE", "http://localhost:4200").rstrip("/")
SECRET = os.environ.get("MANYREACH_WEBHOOK_SECRET", "")


def build_payload(event_type: str, email: str) -> dict:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    event_id = f"test-{event_type}-{uuid4()}"

    base = {
        "id": event_id,
        "event_type": event_type,
        "email": email,
        "campaign_name": "EPR Pricing Sequence",
        "timestamp": now,
        "lead_name": "Test Lead",
    }

    if event_type in ("click", "clicked"):
        base["event_type"] = "clicked"
        base["url"] = "https://climeto.com/pricing-brochure.pdf"
        base["subject"] = "EPR pricing brochure"
    elif event_type in ("open", "opened"):
        base["event_type"] = "opened"
    elif event_type in ("reply", "replied"):
        base["event_type"] = "replied"
        base["subject"] = "Re: EPR quotation"
    elif event_type in ("bounce", "bounced"):
        base["event_type"] = "bounced"
    elif event_type in ("sent", "send"):
        base["event_type"] = "sent"
    else:
        base["event_type"] = event_type

    return base


def post_event(payload: dict) -> None:
    if not SECRET:
        print("MANYREACH_WEBHOOK_SECRET env var required", file=sys.stderr)
        sys.exit(1)

    url = f"{API_BASE}/api/webhooks/manyreach?token={SECRET}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            print(f"HTTP {resp.status}: {body}")
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        print(f"HTTP {err.code}: {body}", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Send test Manyreach webhook events")
    parser.add_argument(
        "--type",
        default="reply",
        help="reply|click|open|bounce|sent (or --all)",
    )
    parser.add_argument(
        "--email",
        default="procurement@abcpolymers.in",
        help="Lead email (matched against seeded leads by default)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Send reply, click, open, bounce, sent",
    )
    args = parser.parse_args()

    types = ["reply", "click", "open", "bounce", "sent"] if args.all else [args.type]
    for event_type in types:
        payload = build_payload(event_type, args.email)
        print(f"Sending {payload['event_type']} -> {args.email}")
        post_event(payload)


if __name__ == "__main__":
    main()
