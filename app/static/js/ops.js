// Placement Surge Portal - Control Room (Ops) Script
// Real-time fleet monitoring, hand-crafted SVG sparkline, surge instructions, self-healing test

document.addEventListener("DOMContentLoaded", () => {
    const liveDot = document.getElementById("live-dot");
    const liveLabel = document.getElementById("live-label");
    const figNodes = document.getElementById("fig-nodes");
    const figCpu = document.getElementById("fig-cpu");
    const figAzs = document.getElementById("fig-azs");
    const nodesBody = document.getElementById("nodes-body");
    const sparklineLine = document.getElementById("sparkline-line");
    const surgeCmdText = document.getElementById("surge-cmd-text");
    const copySurgeBtn = document.getElementById("copy-surge-btn");
    const adminTokenInput = document.getElementById("admin-token-input");
    const failBtn = document.getElementById("fail-btn");
    const recoverBtn = document.getElementById("recover-btn");
    const healResult = document.getElementById("heal-result");
    const eventLog = document.getElementById("event-log");

    // Session-level state
    const nodeHistory = []; // array of node counts for sparkline
    const maxHistory = 40;
    let knownNodes = new Map(); // instanceId -> { az, cpu, state, lastSeen }
    let hasPolledOnce = false;

    // Prefill surge command text
    const origin = window.location.origin;
    const surgeCommand = `./loadtest.sh "${origin}" 300 50`;
    if (surgeCmdText) {
        surgeCmdText.textContent = surgeCommand;
    }

    if (copySurgeBtn) {
        copySurgeBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(surgeCommand).then(() => {
                const origText = copySurgeBtn.textContent;
                copySurgeBtn.textContent = "Copied";
                setTimeout(() => {
                    copySurgeBtn.textContent = origText;
                }, 2000);
            }).catch(() => {
                // Fallback selection
                const range = document.createRange();
                range.selectNodeContents(surgeCmdText);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            });
        });
    }

    // Restore admin token from sessionStorage if present
    const savedToken = sessionStorage.getItem("placement_admin_token");
    if (savedToken && adminTokenInput) {
        adminTokenInput.value = savedToken;
    }

    if (adminTokenInput) {
        adminTokenInput.addEventListener("input", (e) => {
            sessionStorage.setItem("placement_admin_token", e.target.value);
        });
    }

    // Helper: format uptime seconds into "Xm Ys" or "Xh Ym"
    function formatUptime(sec) {
        if (!sec || isNaN(sec)) return "0s";
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    // Helper: log event to eventLog element
    function logEvent(message) {
        if (!eventLog) return;
        const entry = document.createElement("div");
        entry.className = "event-entry";

        const timeSpan = document.createElement("span");
        timeSpan.className = "event-time";
        const now = new Date();
        timeSpan.textContent = `[${now.toTimeString().split(" ")[0]}]`;

        const msgSpan = document.createElement("span");
        msgSpan.className = "event-msg";
        msgSpan.textContent = message;

        entry.appendChild(timeSpan);
        entry.appendChild(msgSpan);
        eventLog.appendChild(entry);
        eventLog.scrollTop = eventLog.scrollHeight;
    }

    // Update the hand-built SVG sparkline
    function updateSparkline(count) {
        nodeHistory.push(count);
        if (nodeHistory.length > maxHistory) {
            nodeHistory.shift();
        }

        if (nodeHistory.length < 2 || !sparklineLine) {
            return;
        }

        const width = 400;
        const height = 60;
        const padding = 8;
        const maxVal = Math.max(4, ...nodeHistory);
        const minVal = 0;

        const points = nodeHistory.map((val, idx) => {
            const x = (idx / (maxHistory - 1)) * (width - padding * 2) + padding;
            const y = height - padding - ((val - minVal) / (maxVal - minVal)) * (height - padding * 2);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(" ");

        sparklineLine.setAttribute("points", points);
    }

    // Fleet polling loop
    function pollFleet() {
        fetch("/api/fleet")
            .then((resp) => {
                if (!resp.ok) throw new Error("Failed to fetch fleet");
                return resp.json();
            })
            .then((nodes) => {
                // Set live indicator active
                if (liveDot) liveDot.classList.add("active");
                if (liveLabel) liveLabel.textContent = "Live";

                renderFleet(nodes);
            })
            .catch((err) => {
                console.warn("Fleet poll error:", err);
                if (liveDot) liveDot.classList.remove("active");
                if (liveLabel) liveLabel.textContent = "Disconnected";
            });
    }

    function renderFleet(nodes) {
        // Summary metrics
        const nodeCount = nodes.length;
        const totalCpu = nodes.reduce((acc, n) => acc + (n.cpu || 0), 0);
        const avgCpu = nodeCount > 0 ? (totalCpu / nodeCount).toFixed(1) : "0.0";
        const azs = new Set(nodes.map((n) => n.az)).size;

        if (figNodes) figNodes.textContent = nodeCount;
        if (figCpu) figCpu.textContent = `${avgCpu}%`;
        if (figAzs) figAzs.textContent = azs;

        updateSparkline(nodeCount);

        // Detect events (joins, leaves, status changes)
        const currentMap = new Map();
        nodes.forEach((n) => currentMap.set(n.instanceId, n));

        if (!hasPolledOnce) {
            logEvent(`Control Room connected. Detected ${nodeCount} active node${nodeCount === 1 ? "" : "s"}.`);
            hasPolledOnce = true;
        } else {
            // Check for new nodes
            nodes.forEach((n) => {
                if (!knownNodes.has(n.instanceId)) {
                    logEvent(`Node ${n.instanceId} joined fleet in ${n.az}.`);
                }
            });

            // Check for disappeared nodes
            knownNodes.forEach((prev, id) => {
                if (!currentMap.has(id)) {
                    logEvent(`Node ${id} in ${prev.az} left fleet or ceased heartbeats.`);
                }
            });
        }

        knownNodes = currentMap;

        // Render table
        if (!nodesBody) return;
        nodesBody.textContent = "";

        if (nodes.length === 0) {
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            td.colSpan = 5;
            td.textContent = "No active nodes reporting in the last 15 seconds.";
            tr.appendChild(td);
            nodesBody.appendChild(tr);
            return;
        }

        nodes.forEach((node) => {
            const tr = document.createElement("tr");

            // Instance ID
            const tdId = document.createElement("td");
            tdId.className = "mono";
            tdId.textContent = node.instanceId;

            // AZ
            const tdAz = document.createElement("td");
            tdAz.className = "mono";
            tdAz.textContent = node.az;

            // CPU
            const tdCpu = document.createElement("td");
            const cpuWrap = document.createElement("div");
            cpuWrap.className = "node-cpu-cell";
            const cpuTrack = document.createElement("div");
            cpuTrack.className = "cpu-track";
            const cpuFill = document.createElement("div");
            cpuFill.className = "cpu-fill";
            const clampedCpu = Math.min(100, Math.max(0, node.cpu));
            cpuFill.style.width = `${clampedCpu}%`;
            cpuTrack.appendChild(cpuFill);
            const cpuVal = document.createElement("span");
            cpuVal.className = "mono";
            cpuVal.textContent = `${clampedCpu.toFixed(1)}%`;
            cpuWrap.appendChild(cpuTrack);
            cpuWrap.appendChild(cpuVal);
            tdCpu.appendChild(cpuWrap);

            // Uptime
            const tdUptime = document.createElement("td");
            tdUptime.className = "mono";
            tdUptime.textContent = formatUptime(node.uptimeSec);

            // State
            const tdState = document.createElement("td");
            const badge = document.createElement("span");
            const isHealthy = node.state === "healthy";
            badge.className = `state-badge ${isHealthy ? "state-healthy" : "state-unhealthy"}`;
            badge.textContent = node.state || "unknown";
            tdState.appendChild(badge);

            tr.appendChild(tdId);
            tr.appendChild(tdAz);
            tr.appendChild(tdCpu);
            tr.appendChild(tdUptime);
            tr.appendChild(tdState);

            nodesBody.appendChild(tr);
        });
    }

    // Self-healing controls
    if (failBtn) {
        failBtn.addEventListener("click", () => {
            const token = adminTokenInput ? adminTokenInput.value.trim() : "";
            if (!token) {
                if (healResult) healResult.textContent = "Error: Admin token is required.";
                return;
            }

            failBtn.disabled = true;
            if (healResult) healResult.textContent = "Setting health check to failing…";

            fetch("/api/ops/fail-health", {
                method: "POST",
                headers: {
                    "X-Admin-Token": token
                }
            })
                .then((resp) => {
                    const servedBy = resp.headers.get("X-Served-By") || "unknown";
                    if (resp.status === 204) {
                        if (healResult) {
                            healResult.textContent = `Node ${servedBy} set to FAILING (503). ALB will mark target unhealthy and ASG will replace it.`;
                        }
                        logEvent(`Simulated failure triggered on node ${servedBy}. Node returning 503.`);
                    } else if (resp.status === 401) {
                        if (healResult) healResult.textContent = "Error 401: Invalid admin token.";
                    } else {
                        if (healResult) healResult.textContent = `Error: Unexpected status ${resp.status}.`;
                    }
                })
                .catch((err) => {
                    if (healResult) healResult.textContent = `Request failed: ${err.message}`;
                })
                .finally(() => {
                    failBtn.disabled = false;
                });
        });
    }

    if (recoverBtn) {
        recoverBtn.addEventListener("click", () => {
            const token = adminTokenInput ? adminTokenInput.value.trim() : "";
            if (!token) {
                if (healResult) healResult.textContent = "Error: Admin token is required.";
                return;
            }

            recoverBtn.disabled = true;
            if (healResult) healResult.textContent = "Recovering health status…";

            fetch("/api/ops/recover", {
                method: "POST",
                headers: {
                    "X-Admin-Token": token
                }
            })
                .then((resp) => {
                    const servedBy = resp.headers.get("X-Served-By") || "unknown";
                    if (resp.status === 204) {
                        if (healResult) {
                            healResult.textContent = `Node ${servedBy} recovered. /health now returns 200 OK.`;
                        }
                        logEvent(`Manual recovery triggered on node ${servedBy}. /health returning 200.`);
                    } else if (resp.status === 401) {
                        if (healResult) healResult.textContent = "Error 401: Invalid admin token.";
                    } else {
                        if (healResult) healResult.textContent = `Error: Unexpected status ${resp.status}.`;
                    }
                })
                .catch((err) => {
                    if (healResult) healResult.textContent = `Request failed: ${err.message}`;
                })
                .finally(() => {
                    recoverBtn.disabled = false;
                });
        });
    }

    // Begin polling every 3 seconds
    pollFleet();
    setInterval(pollFleet, 3000);
});
