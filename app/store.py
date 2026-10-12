"""Storage abstraction: DynamoDB for production, in-memory dict for LOCAL_MODE."""

import time
import threading
from decimal import Decimal

import config


class DuplicateError(Exception):
    """Raised when a duplicate registration (same roll + drive) is attempted."""


class InMemoryStore:
    """Thread-safe in-memory store for local development."""

    DuplicateError = DuplicateError

    def __init__(self):
        self._registrations = {}   # (driveId, roll) -> dict
        self._fleet = {}           # instanceId -> dict
        self._lock = threading.Lock()

    def save_registration(self, *, drive_id, roll, name, email, branch,
                          cgpa, resume_url, receipt_id, served_by, az, timestamp):
        key = (drive_id, roll)
        with self._lock:
            if key in self._registrations:
                raise DuplicateError()
            self._registrations[key] = {
                "driveId": drive_id, "roll": roll, "name": name,
                "email": email, "branch": branch, "cgpa": cgpa,
                "resumeUrl": resume_url, "receiptId": receipt_id,
                "servedBy": served_by, "az": az, "timestamp": timestamp,
            }

    def get_registration_count(self, drive_id):
        with self._lock:
            return sum(1 for (d, _) in self._registrations if d == drive_id)

    def save_heartbeat(self, *, instance_id, az, cpu, uptime, state, last_seen, ttl):
        with self._lock:
            self._fleet[instance_id] = {
                "instanceId": instance_id,
                "az": az,
                "cpu": round(cpu, 1),
                "uptimeSec": int(uptime),
                "state": state,
                "lastSeen": int(last_seen),
            }

    def get_fleet_nodes(self):
        cutoff = int(time.time()) - 15
        with self._lock:
            return [
                dict(n) for n in self._fleet.values()
                if n["lastSeen"] > cutoff
            ]


class DynamoStore:
    """DynamoDB-backed store for production."""

    DuplicateError = DuplicateError

    def __init__(self):
        import boto3
        ddb = boto3.resource("dynamodb", region_name=config.AWS_REGION)
        self._reg_table = ddb.Table(config.REG_TABLE)
        self._fleet_table = ddb.Table(config.FLEET_TABLE)

    def save_registration(self, *, drive_id, roll, name, email, branch,
                          cgpa, resume_url, receipt_id, served_by, az, timestamp):
        from botocore.exceptions import ClientError
        try:
            self._reg_table.put_item(
                Item={
                    "driveId": drive_id,
                    "roll": roll,
                    "name": name,
                    "email": email,
                    "branch": branch,
                    "cgpa": Decimal(str(cgpa)),
                    "resumeUrl": resume_url or "",
                    "receiptId": receipt_id,
                    "servedBy": served_by,
                    "az": az,
                    "timestamp": timestamp,
                },
                ConditionExpression="attribute_not_exists(driveId) AND attribute_not_exists(roll)",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise DuplicateError()
            raise

    def get_registration_count(self, drive_id):
        resp = self._reg_table.query(
            KeyConditionExpression="driveId = :did",
            ExpressionAttributeValues={":did": drive_id},
            Select="COUNT",
        )
        return resp["Count"]

    def save_heartbeat(self, *, instance_id, az, cpu, uptime, state, last_seen, ttl):
        self._fleet_table.put_item(
            Item={
                "instanceId": instance_id,
                "az": az,
                "cpu": Decimal(str(round(cpu, 1))),
                "uptimeSec": int(uptime),
                "state": state,
                "lastSeen": int(last_seen),
                "ttl": int(ttl),
            }
        )

    def get_fleet_nodes(self):
        cutoff = int(time.time()) - 15
        resp = self._fleet_table.scan()
        nodes = []
        for item in resp.get("Items", []):
            if int(item.get("lastSeen", 0)) > cutoff:
                nodes.append({
                    "instanceId": item["instanceId"],
                    "az": item["az"],
                    "cpu": float(item["cpu"]),
                    "uptimeSec": int(item["uptimeSec"]),
                    "state": item["state"],
                    "lastSeen": int(item["lastSeen"]),
                })
        return nodes


def get_store():
    """Return the appropriate store instance based on LOCAL_MODE."""
    if config.LOCAL_MODE:
        return InMemoryStore()
    return DynamoStore()
