"""Node identity via EC2 IMDSv2 token flow, with LOCAL_MODE fallback."""

import os
import urllib.request

from config import LOCAL_MODE

_node_id = None
_node_az = None


def get_node_identity():
    """Return (instance_id, availability_zone). Cached after first call."""
    global _node_id, _node_az
    if _node_id is not None:
        return _node_id, _node_az

    if LOCAL_MODE:
        _node_id = "i-local-%05d" % os.getpid()
        _node_az = "local-1a"
        return _node_id, _node_az

    # IMDSv2: obtain a session token first
    token_req = urllib.request.Request(
        "http://169.254.169.254/latest/api/token",
        method="PUT",
        headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"},
    )
    with urllib.request.urlopen(token_req, timeout=2) as resp:
        token = resp.read().decode()

    meta_headers = {"X-aws-ec2-metadata-token": token}

    id_req = urllib.request.Request(
        "http://169.254.169.254/latest/meta-data/instance-id",
        headers=meta_headers,
    )
    with urllib.request.urlopen(id_req, timeout=2) as resp:
        _node_id = resp.read().decode()

    az_req = urllib.request.Request(
        "http://169.254.169.254/latest/meta-data/placement/availability-zone",
        headers=meta_headers,
    )
    with urllib.request.urlopen(az_req, timeout=2) as resp:
        _node_az = resp.read().decode()

    return _node_id, _node_az
