"""Comprehensive unit and integration tests for the Placement Surge Portal."""

import os
import sys
import tempfile
import pathlib
import pytest

# Ensure app module can be imported
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "app")))

# Set environment variables for testing before importing app
os.environ["LOCAL_MODE"] = "1"
os.environ["TESTING"] = "1"
os.environ["ADMIN_TOKEN"] = "test-secret-token-xyz"

import app as portal_app
import config
from store import get_store, DuplicateError


@pytest.fixture
def client():
    portal_app.app.config["TESTING"] = True
    # Clean up any leftover health flag
    portal_app.HEALTH_FLAG.unlink(missing_ok=True)
    with portal_app.app.test_client() as client:
        yield client
    # Clean up after test
    portal_app.HEALTH_FLAG.unlink(missing_ok=True)


def test_pages_render(client):
    """Verify portal and ops pages render with security headers and expected content."""
    res_portal = client.get("/")
    assert res_portal.status_code == 200
    assert config.COLLEGE_NAME.encode() in res_portal.data
    assert "X-Served-By" in res_portal.headers
    assert "Content-Security-Policy" in res_portal.headers
    assert res_portal.headers["X-Frame-Options"] == "DENY"

    res_ops = client.get("/ops")
    assert res_ops.status_code == 200
    assert b"Control Room" in res_ops.data


def test_health_check_and_admin_toggle(client):
    """Test /health initial state, failure simulation, auth protection, and recovery."""
    # 1. Initially healthy
    res = client.get("/health")
    assert res.status_code == 200
    assert res.data == b"ok"

    # 2. Unauthorized fail attempt
    res = client.post("/api/ops/fail-health")
    assert res.status_code == 401

    res = client.post("/api/ops/fail-health", headers={"X-Admin-Token": "wrong-token"})
    assert res.status_code == 401

    # 3. Authorized fail
    res = client.post("/api/ops/fail-health", headers={"X-Admin-Token": "test-secret-token-xyz"})
    assert res.status_code == 204

    # 4. Now /health returns 503
    res = client.get("/health")
    assert res.status_code == 503
    assert res.data == b"failing"

    # 5. Authorized recover
    res = client.post("/api/ops/recover", headers={"X-Admin-Token": "test-secret-token-xyz"})
    assert res.status_code == 204

    # 6. /health returns 200 again
    res = client.get("/health")
    assert res.status_code == 200
    assert res.data == b"ok"


def test_drives_api(client):
    """Verify /api/drives returns the 4 seeded fictional drives."""
    res = client.get("/api/drives")
    assert res.status_code == 200
    data = res.get_json()
    assert len(data) == 4
    drive_ids = [d["driveId"] for d in data]
    assert "DRV-001" in drive_ids
    assert "DRV-002" in drive_ids
    assert all("registeredCount" in d for d in data)


def test_registration_validation(client):
    """Verify server-side validation rejecting invalid or missing fields."""
    # Empty body
    res = client.post("/api/register", json={})
    assert res.status_code == 400
    errors = res.get_json()["errors"]
    assert "driveId" in errors
    assert "name" in errors
    assert "roll" in errors
    assert "email" in errors
    assert "branch" in errors
    assert "cgpa" in errors

    # Invalid email, negative CGPA, invalid name characters
    bad_payload = {
        "driveId": "DRV-001",
        "name": "Jane Doe 1234 #!",
        "roll": "ROLL-001",
        "email": "not-an-email",
        "branch": "CSE",
        "cgpa": -1.5,
        "resumeUrl": "ftp://invalid-url"
    }
    res = client.post("/api/register", json=bad_payload)
    assert res.status_code == 400
    errors = res.get_json()["errors"]
    assert "name" in errors
    assert "email" in errors
    assert "cgpa" in errors
    assert "resumeUrl" in errors


def test_registration_eligibility(client):
    """Verify branch and CGPA requirements are enforced (422)."""
    # DRV-001: Meridian Analytics, min CGPA 7.0, branches: CSE, IT, ECE
    ineligible_branch = {
        "driveId": "DRV-001",
        "name": "Alex Student",
        "roll": "MECH101",
        "email": "alex@example.edu",
        "branch": "ME",  # Ineligible for DRV-001
        "cgpa": 8.5
    }
    res = client.post("/api/register", json=ineligible_branch)
    assert res.status_code == 422
    assert "ME is not eligible" in res.get_json()["error"]

    ineligible_cgpa = {
        "driveId": "DRV-001",
        "name": "Alex Student",
        "roll": "CSE101",
        "email": "alex@example.edu",
        "branch": "CSE",
        "cgpa": 6.8  # Below min 7.0
    }
    res = client.post("/api/register", json=ineligible_cgpa)
    assert res.status_code == 422
    assert "CGPA must be 7.0 or above" in res.get_json()["error"]


def test_successful_registration_and_duplicate_prevention(client):
    """Verify registration succeeds with 201, and duplicate attempt returns 409."""
    valid_student = {
        "driveId": "DRV-001",
        "name": "Priya Sharma",
        "roll": "2023CS042",
        "email": "priya.sharma@example.edu",
        "branch": "CSE",
        "cgpa": 8.92,
        "resumeUrl": "https://example.edu/resumes/priya.pdf"
    }

    # 1. First registration succeeds
    res1 = client.post("/api/register", json=valid_student)
    assert res1.status_code == 201
    data = res1.get_json()
    assert data["receiptId"].startswith("REC-")
    assert data["driveId"] == "DRV-001"
    assert data["company"] == "Meridian Analytics"
    assert data["name"] == "Priya Sharma"
    assert "servedBy" in data
    assert "az" in data
    assert "timestamp" in data

    # 2. Duplicate registration attempt with same roll and drive returns 409
    res2 = client.post("/api/register", json=valid_student)
    assert res2.status_code == 409
    assert "already registered" in res2.get_json()["error"]

    # 3. Same student registering for a different eligible drive succeeds
    valid_second_drive = dict(valid_student)
    valid_second_drive["driveId"] = "DRV-003"  # Fathom Tech: CSE eligible, min 7.0
    res3 = client.post("/api/register", json=valid_second_drive)
    assert res3.status_code == 201
    assert res3.get_json()["driveId"] == "DRV-003"


def test_load_and_fleet_apis(client):
    """Verify /api/load burns CPU and /api/fleet returns node statuses."""
    res_load = client.get("/api/load?ms=50")
    assert res_load.status_code == 200
    data = res_load.get_json()
    assert data["burned"] == 50
    assert "servedBy" in data

    # Add a mock heartbeat to store and query fleet
    store = portal_app.store
    import time
    now = time.time()
    store.save_heartbeat(
        instance_id="i-test-01",
        az="ap-southeast-2a",
        cpu=18.5,
        uptime=3600,
        state="healthy",
        last_seen=now,
        ttl=now + 60,
    )

    res_fleet = client.get("/api/fleet")
    assert res_fleet.status_code == 200
    fleet = res_fleet.get_json()
    assert len(fleet) >= 1
    node = next(n for n in fleet if n["instanceId"] == "i-test-01")
    assert node["az"] == "ap-southeast-2a"
    assert node["cpu"] == 18.5
    assert node["state"] == "healthy"


def test_api_ping_and_config(client):
    """Verify /api/ping returns serving node and rotates in local mode, and /api/config returns fleet config."""
    # Test /api/ping
    res_ping1 = client.get("/api/ping")
    assert res_ping1.status_code == 200
    p1 = res_ping1.get_json()
    assert "servedBy" in p1
    assert "az" in p1

    res_ping2 = client.get("/api/ping")
    assert res_ping2.status_code == 200
    p2 = res_ping2.get_json()
    assert "servedBy" in p2
    # In local mode, consecutive calls rotate across fake nodes
    assert p1["servedBy"] != p2["servedBy"]

    # Test /api/config
    res_cfg = client.get("/api/config")
    assert res_cfg.status_code == 200
    cfg = res_cfg.get_json()
    assert cfg["region"] == "ap-southeast-2"
    assert cfg["asg"]["min"] == 2
    assert cfg["asg"]["max"] == 4
    assert cfg["asg"]["targetCpu"] == 50
    assert cfg["healthCheck"]["path"] == "/health"
    assert cfg["healthCheck"]["intervalSec"] == 10
    assert "instanceType" in cfg

