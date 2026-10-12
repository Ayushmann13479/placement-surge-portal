"""Heartbeat process: writes node status to the fleet table every 5 seconds.

Production: runs as a standalone systemd unit (one per EC2 instance).
LOCAL_MODE: started as daemon threads from app.py for 3 simulated nodes.
"""

import os
import sys
import time
import random
import threading

import config
from node import get_node_identity

_start_time = time.time()


def _get_cpu():
    """Get current CPU utilisation percentage."""
    try:
        import psutil
        return psutil.cpu_percent(interval=1)
    except ImportError:
        return random.uniform(5.0, 35.0)


def _get_uptime():
    """Get system uptime in seconds."""
    try:
        with open("/proc/uptime") as f:
            return float(f.read().split()[0])
    except (FileNotFoundError, PermissionError, OSError):
        return time.time() - _start_time


def heartbeat_loop(store, instance_id, az, cpu_fn=None):
    """Run the heartbeat loop forever, writing to the fleet table every 5 s."""
    if cpu_fn is None:
        cpu_fn = _get_cpu
    while True:
        try:
            now = time.time()
            store.save_heartbeat(
                instance_id=instance_id,
                az=az,
                cpu=cpu_fn(),
                uptime=_get_uptime(),
                state="healthy",
                last_seen=now,
                ttl=now + 60,
            )
        except Exception as exc:
            print("[heartbeat] Error: %s" % exc, file=sys.stderr)
        time.sleep(5)


def start_local_heartbeat(store):
    """Start heartbeat threads for 3 fake nodes with varying CPU profiles."""
    fake_nodes = [
        ("i-local-node-01", "local-1a", lambda: random.uniform(10, 30)),
        ("i-local-node-02", "local-1b", lambda: random.uniform(25, 55)),
        ("i-local-node-03", "local-1a", lambda: random.uniform(40, 75)),
    ]
    for nid, az, cpu_fn in fake_nodes:
        t = threading.Thread(
            target=heartbeat_loop,
            args=(store, nid, az, cpu_fn),
            daemon=True,
        )
        t.start()
    print("[heartbeat] Started 3 local fake nodes", file=sys.stderr)


if __name__ == "__main__":
    from store import get_store

    store = get_store()
    instance_id, az = get_node_identity()
    print("[heartbeat] Starting for %s in %s" % (instance_id, az))
    heartbeat_loop(store, instance_id, az)
