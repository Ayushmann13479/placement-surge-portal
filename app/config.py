"""Application configuration loaded from environment variables."""

import os
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))

COLLEGE_NAME = os.environ.get("COLLEGE_NAME", "Career Development Centre")
AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
REG_TABLE = os.environ.get("REG_TABLE", "placement-surge-registrations")
FLEET_TABLE = os.environ.get("FLEET_TABLE", "placement-surge-fleet")
ADMIN_TOKEN_PARAM = os.environ.get("ADMIN_TOKEN_PARAM", "/placement-surge/admin-token")
LOCAL_MODE = os.environ.get("LOCAL_MODE", "0") == "1"


def _next_deadline_base():
    """Return the next 09:00 IST from now."""
    now = datetime.now(IST)
    base = now.replace(hour=9, minute=0, second=0, microsecond=0)
    if now >= base:
        base += timedelta(days=1)
    return base


_base = _next_deadline_base()

DRIVES = [
    {
        "driveId": "DRV-001",
        "company": "Meridian Analytics",
        "role": "Data Analyst",
        "ctcRange": "8\u201312 LPA",
        "minCgpa": 7.0,
        "branches": ["CSE", "IT", "ECE"],
        "deadline": (_base + timedelta(days=1)).isoformat(),
    },
    {
        "driveId": "DRV-002",
        "company": "Prism Robotics",
        "role": "Embedded Systems Engineer",
        "ctcRange": "10\u201314 LPA",
        "minCgpa": 7.5,
        "branches": ["ECE", "EEE", "ME"],
        "deadline": (_base + timedelta(days=2)).isoformat(),
    },
    {
        "driveId": "DRV-003",
        "company": "Fathom Technologies",
        "role": "Backend Developer",
        "ctcRange": "12\u201318 LPA",
        "minCgpa": 7.0,
        "branches": ["CSE", "IT"],
        "deadline": (_base + timedelta(days=3)).isoformat(),
    },
    {
        "driveId": "DRV-004",
        "company": "Canopy Financial",
        "role": "Risk Analyst",
        "ctcRange": "9\u201313 LPA",
        "minCgpa": 8.0,
        "branches": ["CSE", "IT", "ECE", "ME", "CE"],
        "deadline": (_base + timedelta(days=5)).isoformat(),
    },
]
