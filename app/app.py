"""Placement Surge Portal -- Flask application.

All routes, security headers, validation, rate limiting, and admin controls.
"""

import os
import re
import time
import hmac
import uuid
import pathlib
import logging
import threading
from datetime import datetime
from functools import wraps
from collections import defaultdict

from flask import Flask, request, jsonify, render_template

from config import COLLEGE_NAME, AWS_REGION, LOCAL_MODE, ADMIN_TOKEN_PARAM, DRIVES, IST
from node import get_node_identity
from store import get_store, DuplicateError

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4096  # 4 KB body cap

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("placement")

store = get_store()

import tempfile

# ---------------------------------------------------------------------------
# Health flag (file-based so all gunicorn workers agree)
# ---------------------------------------------------------------------------

HEALTH_FLAG = pathlib.Path(tempfile.gettempdir()) / "placement-surge-unhealthy"


def is_healthy():
    return not HEALTH_FLAG.exists()


# ---------------------------------------------------------------------------
# Rate limiter (in-memory, per-IP, 10/min, first X-Forwarded-For hop)
# ---------------------------------------------------------------------------

_rate_lock = threading.Lock()
_rate_buckets: dict[str, list[float]] = defaultdict(list)


def _get_client_ip():
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _check_rate_limit(ip, limit=10, window=60):
    now = time.time()
    with _rate_lock:
        bucket = _rate_buckets[ip]
        _rate_buckets[ip] = [t for t in bucket if now - t < window]
        if len(_rate_buckets[ip]) >= limit:
            return False
        _rate_buckets[ip].append(now)
        return True


# ---------------------------------------------------------------------------
# Admin token (read from SSM Parameter Store at startup)
# ---------------------------------------------------------------------------

_admin_token = None


def _load_admin_token():
    global _admin_token
    if LOCAL_MODE:
        _admin_token = os.environ.get("ADMIN_TOKEN", "local-dev-token-12345")
        return
    import boto3
    ssm = boto3.client("ssm", region_name=AWS_REGION)
    resp = ssm.get_parameter(Name=ADMIN_TOKEN_PARAM, WithDecryption=True)
    _admin_token = resp["Parameter"]["Value"]


try:
    _load_admin_token()
except Exception as exc:
    logger.warning("Could not load admin token: %s", exc)
    _admin_token = "UNAVAILABLE"


def require_admin(f):
    """Decorator: require a valid X-Admin-Token header (constant-time compare)."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("X-Admin-Token", "")
        if not _admin_token or not hmac.compare_digest(
            token.encode("utf-8"), _admin_token.encode("utf-8")
        ):
            return "", 401
        return f(*args, **kwargs)
    return decorated


# ---------------------------------------------------------------------------
# Security headers (every response)
# ---------------------------------------------------------------------------

@app.after_request
def add_security_headers(response):
    node_id, _ = get_node_identity()
    response.headers["X-Served-By"] = node_id
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "font-src 'self' https://fonts.gstatic.com; "
        "style-src 'self' https://fonts.googleapis.com; "
        "frame-ancestors 'none'"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Frame-Options"] = "DENY"
    return response


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/")
def portal():
    return render_template("portal.html", college_name=COLLEGE_NAME, drives=DRIVES)


@app.route("/ops")
def ops():
    node_id, node_az = get_node_identity()
    return render_template(
        "ops.html",
        college_name=COLLEGE_NAME,
        node_id=node_id,
        node_az=node_az,
    )


@app.route("/health")
def health():
    if is_healthy():
        return "ok", 200
    return "failing", 503


# ---------------------------------------------------------------------------
# API: drives
# ---------------------------------------------------------------------------

@app.route("/api/drives")
def api_drives():
    result = []
    for d in DRIVES:
        count = store.get_registration_count(d["driveId"])
        result.append({**d, "registeredCount": count})
    return jsonify(result)


# ---------------------------------------------------------------------------
# API: register
# ---------------------------------------------------------------------------

@app.route("/api/register", methods=["POST"])
def api_register():
    ip = _get_client_ip()
    if not _check_rate_limit(ip):
        return jsonify({"error": "Too many requests. Try again in a minute."}), 429

    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"errors": {"_": "Invalid request body."}}), 400

    # ---- field validation ----
    errors = _validate_registration(data)
    if errors:
        return jsonify({"errors": errors}), 400

    drive_id = data["driveId"].strip()
    drive = next((d for d in DRIVES if d["driveId"] == drive_id), None)
    if not drive:
        return jsonify({"errors": {"driveId": "Unknown drive."}}), 400

    name = data["name"].strip()
    roll = data["roll"].strip().upper()
    email = data["email"].strip().lower()
    branch = data["branch"].strip().upper()
    cgpa = float(data["cgpa"])
    resume_url = data.get("resumeUrl", "").strip()

    # ---- eligibility ----
    if branch not in drive["branches"]:
        return (
            jsonify({
                "error": "%s is not eligible for this drive. Eligible: %s."
                % (branch, ", ".join(drive["branches"]))
            }),
            422,
        )
    if cgpa < drive["minCgpa"]:
        return (
            jsonify({
                "error": "CGPA must be %s or above for this drive." % drive["minCgpa"]
            }),
            422,
        )

    # ---- deadline ----
    deadline = datetime.fromisoformat(drive["deadline"])
    if datetime.now(IST) > deadline:
        return jsonify({"error": "Registrations for this drive have closed."}), 422

    # ---- persist ----
    receipt_id = "REC-%s" % uuid.uuid4().hex[:8].upper()
    node_id, node_az = get_node_identity()
    timestamp = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S IST")

    try:
        store.save_registration(
            drive_id=drive_id, roll=roll, name=name, email=email,
            branch=branch, cgpa=cgpa, resume_url=resume_url,
            receipt_id=receipt_id, served_by=node_id, az=node_az,
            timestamp=timestamp,
        )
    except DuplicateError:
        return (
            jsonify({
                "error": "Roll number %s is already registered for this drive." % roll
            }),
            409,
        )

    # Log receipt ID only -- never PII
    logger.info("Registration: receipt=%s drive=%s node=%s", receipt_id, drive_id, node_id)

    return (
        jsonify({
            "receiptId": receipt_id,
            "driveId": drive_id,
            "company": drive["company"],
            "role": drive["role"],
            "servedBy": node_id,
            "az": node_az,
            "name": name,
            "timestamp": timestamp,
        }),
        201,
    )


_NAME_RE = re.compile(r"^[A-Za-z\s.'\-]+$")
_ROLL_RE = re.compile(r"^[A-Za-z0-9]+$")
_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")


def _validate_registration(data):
    """Return a dict of {fieldName: errorMessage} or empty dict if valid."""
    errors = {}

    # driveId
    drive_id = data.get("driveId", "")
    if not isinstance(drive_id, str) or not drive_id.strip():
        errors["driveId"] = "Drive is required."

    # name
    name = data.get("name", "")
    if not isinstance(name, str) or not name.strip():
        errors["name"] = "Name is required."
    elif len(name.strip()) > 100:
        errors["name"] = "Name must be 100 characters or fewer."
    elif not _NAME_RE.match(name.strip()):
        errors["name"] = "Name contains invalid characters."

    # roll
    roll = data.get("roll", "")
    if not isinstance(roll, str) or not roll.strip():
        errors["roll"] = "Roll number is required."
    elif len(roll.strip()) > 20:
        errors["roll"] = "Roll number is too long."
    elif not _ROLL_RE.match(roll.strip()):
        errors["roll"] = "Roll number must be alphanumeric."

    # email
    email = data.get("email", "")
    if not isinstance(email, str) or not email.strip():
        errors["email"] = "Email is required."
    elif len(email.strip()) > 100:
        errors["email"] = "Email is too long."
    elif not _EMAIL_RE.match(email.strip()):
        errors["email"] = "Enter a valid email address."

    # branch
    branch = data.get("branch", "")
    if not isinstance(branch, str) or not branch.strip():
        errors["branch"] = "Branch is required."

    # cgpa
    cgpa_raw = data.get("cgpa")
    if cgpa_raw is None or (isinstance(cgpa_raw, str) and not cgpa_raw.strip()):
        errors["cgpa"] = "CGPA is required."
    else:
        try:
            cgpa = float(cgpa_raw)
            if cgpa < 0 or cgpa > 10:
                errors["cgpa"] = "CGPA must be between 0 and 10."
        except (ValueError, TypeError):
            errors["cgpa"] = "CGPA must be a number."

    # resumeUrl (optional)
    resume_url = data.get("resumeUrl", "")
    if resume_url and isinstance(resume_url, str) and resume_url.strip():
        if len(resume_url.strip()) > 500:
            errors["resumeUrl"] = "URL is too long."
        elif not resume_url.strip().startswith(("http://", "https://")):
            errors["resumeUrl"] = "URL must start with http:// or https://."

    return errors


# ---------------------------------------------------------------------------
# API: fleet
# ---------------------------------------------------------------------------

@app.route("/api/fleet")
def api_fleet():
    nodes = store.get_fleet_nodes()
    return jsonify(nodes)


# ---------------------------------------------------------------------------
# API: load (CPU burn for testing)
# ---------------------------------------------------------------------------

@app.route("/api/load")
def api_load():
    ms = min(int(request.args.get("ms", 300)), 500)
    end = time.time() + ms / 1000.0
    while time.time() < end:
        sum(i * i for i in range(1000))
    node_id, _ = get_node_identity()
    return jsonify({"burned": ms, "servedBy": node_id})


# ---------------------------------------------------------------------------
# API: ops controls (admin-only)
# ---------------------------------------------------------------------------

@app.route("/api/ops/fail-health", methods=["POST"])
@require_admin
def api_fail_health():
    HEALTH_FLAG.touch()
    node_id, _ = get_node_identity()
    logger.info("Health set to FAILING on %s", node_id)
    return "", 204


@app.route("/api/ops/recover", methods=["POST"])
@require_admin
def api_recover():
    HEALTH_FLAG.unlink(missing_ok=True)
    node_id, _ = get_node_identity()
    logger.info("Health RECOVERED on %s", node_id)
    return "", 204


# ---------------------------------------------------------------------------
# Local-mode heartbeat bootstrap
# ---------------------------------------------------------------------------

if LOCAL_MODE and not os.environ.get("TESTING"):
    HEALTH_FLAG.unlink(missing_ok=True)
    from heartbeat import start_local_heartbeat
    start_local_heartbeat(store)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
