// Placement Surge Portal - Control Room (Ops) Script
// Real-time fleet monitoring, hand-built dual-axis SVG timeline chart, who-answered probes, phase detection

document.addEventListener("DOMContentLoaded", () => {
    // Top strip elements
    const liveDot = document.getElementById("live-dot");
    const liveLabel = document.getElementById("live-label");
    const stripNodes = document.getElementById("strip-nodes");
    const stripNodesCaption = document.getElementById("strip-nodes-caption");
    const stripCpu = document.getElementById("strip-cpu");
    const stripCpuCaption = document.getElementById("strip-cpu-caption");
    const stripAzs = document.getElementById("strip-azs");
    const stripAzsCaption = document.getElementById("strip-azs-caption");
    const stripRps = document.getElementById("strip-rps");
    const stripRpsCaption = document.getElementById("strip-rps-caption");
    const stripLatency = document.getElementById("strip-latency");
    const stripLatencyCaption = document.getElementById("strip-latency-caption");

    // Main column elements
    const nodesBody = document.getElementById("nodes-body");
    const nodesCountTag = document.getElementById("nodes-count-tag");
    const timelineSvg = document.getElementById("timeline-chart");
    const whoAnsweredBars = document.getElementById("who-answered-bars");
    const eventLog = document.getElementById("event-log");
    const eventLogCount = document.getElementById("event-log-count");

    // Aside elements
    const phaseBadge = document.getElementById("phase-badge");
    const phaseDesc = document.getElementById("phase-desc");
    const phaseSteps = document.querySelectorAll(".phase-step");
    const cfgRegion = document.getElementById("cfg-region");
    const cfgCapacity = document.getElementById("cfg-capacity");
    const cfgTargetCpu = document.getElementById("cfg-target-cpu");
    const cfgWarmup = document.getElementById("cfg-warmup");
    const cfgHealth = document.getElementById("cfg-health");
    const cfgInstance = document.getElementById("cfg-instance");
    const cfgAzs = document.getElementById("cfg-azs");
    const regsTotalCount = document.getElementById("regs-total-count");
    const drivesBreakdownList = document.getElementById("drives-breakdown-list");
    const surgeCmdText = document.getElementById("surge-cmd-text");
    const copySurgeBtn = document.getElementById("copy-surge-btn");
    const adminTokenInput = document.getElementById("admin-token-input");
    const failBtn = document.getElementById("fail-btn");
    const recoverBtn = document.getElementById("recover-btn");
    const healResult = document.getElementById("heal-result");

    // State
    let lastSuccessfulFleetPollTime = 0;
    let knownNodes = new Map(); // instanceId -> { firstSeenTime, lastSeen, az, cpu, uptimeSec, state }
    let nodeEventsHistory = []; // { time, text, type }
    const timelinePoints = []; // { time, nodeCount, avgCpu }
    const MAX_TIMELINE_WINDOW_SEC = 15 * 60; // 15 minutes window
    let timelineMarkers = []; // { time, text, type: 'join' | 'leave' }

    // Probes state (last 60 responses)
    const MAX_PROBES = 60;
    const probeResponses = []; // { time, latencyMs, servedBy, ok }

    // Restore admin token from sessionStorage
    const savedToken = sessionStorage.getItem("placement_admin_token");
    if (savedToken && adminTokenInput) {
        adminTokenInput.value = savedToken;
    }
    if (adminTokenInput) {
        adminTokenInput.addEventListener("input", (e) => {
            sessionStorage.setItem("placement_admin_token", e.target.value);
        });
    }

    // Prefill surge command text
    const origin = window.location.origin;
    const surgeCommand = `./loadtest.sh "${origin}" 300 50`;
    if (surgeCmdText) surgeCmdText.textContent = surgeCommand;

    if (copySurgeBtn) {
        copySurgeBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(surgeCommand).then(() => {
                const orig = copySurgeBtn.textContent;
                copySurgeBtn.textContent = "Copied";
                setTimeout(() => { copySurgeBtn.textContent = orig; }, 2000);
            }).catch(() => {
                const range = document.createRange();
                range.selectNodeContents(surgeCmdText);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            });
        });
    }

    // Helper: format relative time "Xm Ys ago" or "Xs ago"
    function formatTimeAgo(sec) {
        if (sec < 60) return `${Math.floor(sec)}s ago`;
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}m ${s}s ago`;
    }

    function formatUptime(sec) {
        if (!sec || isNaN(sec)) return "0s";
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    // Event Log: newest on top
    let totalEventsCount = 0;
    function logEvent(message) {
        if (!eventLog) return;
        totalEventsCount++;
        if (eventLogCount) eventLogCount.textContent = `${totalEventsCount} event${totalEventsCount === 1 ? "" : "s"}`;

        const entry = document.createElement("div");
        entry.className = "event-entry mono";

        const now = new Date();
        const timeStr = now.toTimeString().split(" ")[0];

        const timeSpan = document.createElement("span");
        timeSpan.className = "event-time";
        timeSpan.textContent = `[${timeStr}]`;

        const msgSpan = document.createElement("span");
        msgSpan.className = "event-msg";
        msgSpan.textContent = message;

        entry.appendChild(timeSpan);
        entry.appendChild(msgSpan);

        // Prepend newest on top
        if (eventLog.firstChild) {
            eventLog.insertBefore(entry, eventLog.firstChild);
        } else {
            eventLog.appendChild(entry);
        }
    }

    // Status indicator heartbeat check
    function updateStatusIndicator() {
        const now = Date.now();
        const isLive = (now - lastSuccessfulFleetPollTime) <= 6000;
        if (liveDot && liveLabel) {
            if (isLive) {
                liveDot.classList.add("active");
                liveLabel.textContent = "Live";
            } else {
                liveDot.classList.remove("active");
                liveLabel.textContent = "Disconnected";
            }
        }
    }
    setInterval(updateStatusIndicator, 1000);

    // =========================================================================
    // 1. Probing GET /api/ping once per second
    // =========================================================================
    function runProbe() {
        const start = performance.now();
        fetch("/api/ping")
            .then(async (resp) => {
                const latency = Math.round(performance.now() - start);
                if (!resp.ok) {
                    recordProbe(latency, null, false);
                    logEvent(`Probe failed: GET /api/ping returned HTTP ${resp.status}`);
                    return;
                }
                const data = await resp.json().catch(() => ({}));
                recordProbe(latency, data.servedBy || "unknown", true);
            })
            .catch((err) => {
                const latency = Math.round(performance.now() - start);
                recordProbe(latency, null, false);
                logEvent(`Probe network error: ${err.message}`);
            });
    }

    function recordProbe(latencyMs, servedBy, ok) {
        probeResponses.push({
            time: Date.now(),
            latencyMs,
            servedBy,
            ok,
        });
        if (probeResponses.length > MAX_PROBES) {
            probeResponses.shift();
        }

        updateProbeMetricsAndBars();
    }

    function updateProbeMetricsAndBars() {
        if (probeResponses.length === 0) return;

        // Calculate requests / s
        // Using window between oldest and newest probe
        const now = Date.now();
        const recentProbes = probeResponses.filter((p) => now - p.time <= 10000); // last 10s
        const rps = (recentProbes.length / 10).toFixed(1);
        if (stripRps) stripRps.textContent = rps;
        if (stripRpsCaption) stripRpsCaption.textContent = `${recentProbes.length} in last 10s`;

        // Calculate median and p95 latency
        const latencies = probeResponses.filter((p) => p.ok).map((p) => p.latencyMs).sort((a, b) => a - b);
        if (latencies.length > 0) {
            const midIdx = Math.floor(latencies.length / 2);
            const median = latencies.length % 2 !== 0 ? latencies[midIdx] : Math.round((latencies[midIdx - 1] + latencies[midIdx]) / 2);
            const p95Idx = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
            const p95 = latencies[p95Idx];

            if (stripLatency) stripLatency.textContent = `${median}ms`;
            if (stripLatencyCaption) stripLatencyCaption.textContent = `p95: ${p95}ms (${latencies.length} samples)`;
        }

        // Render "Who answered" horizontal bars
        if (!whoAnsweredBars) return;
        whoAnsweredBars.textContent = "";

        const nodeCounts = new Map();
        let validProbes = 0;
        probeResponses.forEach((p) => {
            if (p.ok && p.servedBy) {
                validProbes++;
                nodeCounts.set(p.servedBy, (nodeCounts.get(p.servedBy) || 0) + 1);
            }
        });

        if (validProbes === 0) {
            const p = document.createElement("p");
            p.className = "mono text-muted";
            p.textContent = "Awaiting successful probes...";
            whoAnsweredBars.appendChild(p);
            return;
        }

        // Sort descending by share
        const sortedNodes = Array.from(nodeCounts.entries()).sort((a, b) => b[1] - a[1]);
        sortedNodes.forEach(([nodeId, count]) => {
            const pct = ((count / validProbes) * 100).toFixed(1);

            const row = document.createElement("div");
            row.className = "probe-node-row";

            const meta = document.createElement("div");
            meta.className = "probe-meta-line mono";

            const nodeSpan = document.createElement("span");
            nodeSpan.textContent = nodeId;

            const statSpan = document.createElement("span");
            statSpan.className = "text-muted";
            statSpan.textContent = `${count} reqs (${pct}%)`;

            meta.appendChild(nodeSpan);
            meta.appendChild(statSpan);

            const track = document.createElement("div");
            track.className = "probe-bar-track";

            const fill = document.createElement("div");
            fill.className = "probe-bar-fill";
            fill.style.width = `${pct}%`;

            track.appendChild(fill);
            row.appendChild(meta);
            row.appendChild(track);

            whoAnsweredBars.appendChild(row);
        });
    }

    // Start probe interval 1Hz
    runProbe();
    setInterval(runProbe, 1000);

    // =========================================================================
    // 2. Fetch /api/config
    // =========================================================================
    function fetchConfig() {
        fetch("/api/config")
            .then((resp) => {
                if (!resp.ok) throw new Error("Failed to load config");
                return resp.json();
            })
            .then((data) => {
                if (cfgRegion) cfgRegion.textContent = data.region;
                if (cfgCapacity && data.asg) cfgCapacity.textContent = `min ${data.asg.min} / des ${data.asg.desired} / max ${data.asg.max}`;
                if (cfgTargetCpu && data.asg) cfgTargetCpu.textContent = `${data.asg.targetCpu}%`;
                if (cfgWarmup && data.asg) cfgWarmup.textContent = `${data.asg.warmupSec}s`;
                if (cfgHealth && data.healthCheck) cfgHealth.textContent = `${data.healthCheck.path} (${data.healthCheck.intervalSec}s, ${data.healthCheck.healthyThreshold}/${data.healthCheck.unhealthyThreshold})`;
                if (cfgInstance) cfgInstance.textContent = data.instanceType;
                if (cfgAzs) cfgAzs.textContent = `${data.azsServing} Availability Zones`;
            })
            .catch((err) => console.warn("Config fetch error:", err));
    }
    fetchConfig();

    // =========================================================================
    // 3. Fetch /api/drives (every 5s) for registrations breakdown
    // =========================================================================
    function fetchDrivesBreakdown() {
        fetch("/api/drives")
            .then((resp) => {
                if (!resp.ok) throw new Error("Failed to load drives");
                return resp.json();
            })
            .then((drives) => {
                const total = drives.reduce((acc, d) => acc + (d.registeredCount || 0), 0);
                if (regsTotalCount) regsTotalCount.textContent = `${total} total`;

                if (!drivesBreakdownList) return;
                drivesBreakdownList.textContent = "";

                const maxCount = Math.max(1, ...drives.map((d) => d.registeredCount || 0));

                drives.forEach((d) => {
                    const item = document.createElement("div");
                    item.className = "reg-breakdown-item";

                    const meta = document.createElement("div");
                    meta.className = "reg-breakdown-meta";

                    const comp = document.createElement("span");
                    comp.textContent = d.company;

                    const countSpan = document.createElement("span");
                    countSpan.className = "mono text-muted";
                    countSpan.textContent = `${d.registeredCount || 0} registered`;

                    meta.appendChild(comp);
                    meta.appendChild(countSpan);

                    const track = document.createElement("div");
                    track.className = "reg-breakdown-track";

                    const fill = document.createElement("div");
                    fill.className = "reg-breakdown-fill";
                    const pct = Math.min(100, Math.round(((d.registeredCount || 0) / maxCount) * 100));
                    fill.style.width = `${pct}%`;

                    track.appendChild(fill);
                    item.appendChild(meta);
                    item.appendChild(track);

                    drivesBreakdownList.appendChild(item);
                });
            })
            .catch((err) => console.warn("Drives breakdown fetch error:", err));
    }
    fetchDrivesBreakdown();
    setInterval(fetchDrivesBreakdown, 5000);

    // =========================================================================
    // 4. Fleet polling: /api/fleet (every 3s)
    // =========================================================================
    function pollFleet() {
        fetch("/api/fleet")
            .then((resp) => {
                if (!resp.ok) throw new Error("Failed to fetch fleet");
                return resp.json();
            })
            .then((nodes) => {
                lastSuccessfulFleetPollTime = Date.now();
                updateStatusIndicator();
                handleFleetData(nodes);
            })
            .catch((err) => {
                console.warn("Fleet poll error:", err);
                updateStatusIndicator();
            });
    }

    function handleFleetData(nodes) {
        const now = Date.now();
        const nodeCount = nodes.length;
        const totalCpu = nodes.reduce((acc, n) => acc + (n.cpu || 0), 0);
        const avgCpu = nodeCount > 0 ? Number((totalCpu / nodeCount).toFixed(1)) : 0.0;
        const azList = Array.from(new Set(nodes.map((n) => n.az))).sort();

        // 1. Update Top Strip
        if (stripNodes) stripNodes.textContent = nodeCount;
        if (stripCpu) stripCpu.textContent = `${avgCpu}%`;
        if (stripAzs) stripAzs.textContent = azList.length;
        if (stripAzsCaption) stripAzsCaption.textContent = azList.length > 0 ? azList.join(", ") : "None";
        if (nodesCountTag) nodesCountTag.textContent = `${nodeCount} reporting`;

        // 2. Track node arrivals and departures
        const currentMap = new Map();
        nodes.forEach((n) => {
            const existing = knownNodes.get(n.instanceId);
            const firstSeenTime = existing ? existing.firstSeenTime : now;
            currentMap.set(n.instanceId, {
                ...n,
                firstSeenTime,
            });

            if (!existing) {
                // New node joined!
                logEvent(`Node ${n.instanceId} joined fleet in ${n.az}`);
                timelineMarkers.push({
                    time: now,
                    text: `+ ${n.instanceId}`,
                    type: "join",
                });
            }
        });

        knownNodes.forEach((prev, id) => {
            if (!currentMap.has(id)) {
                // Node left
                logEvent(`Node ${id} in ${prev.az} left fleet`);
                timelineMarkers.push({
                    time: now,
                    text: `- ${id}`,
                    type: "leave",
                });
            }
        });

        knownNodes = currentMap;

        // 3. Render Nodes Table
        renderNodesTable(Array.from(knownNodes.values()), now);

        // 4. Update Timeline Data & Draw SVG
        timelinePoints.push({
            time: now,
            nodeCount,
            avgCpu,
        });

        // Prune older than 15 mins
        const cutoff = now - MAX_TIMELINE_WINDOW_SEC * 1000;
        while (timelinePoints.length > 0 && timelinePoints[0].time < cutoff) {
            timelinePoints.shift();
        }
        timelineMarkers = timelineMarkers.filter((m) => m.time >= cutoff);

        drawTimelineChart();

        // 5. Update Phase
        updatePhase(nodeCount, avgCpu, nodes);
    }

    function renderNodesTable(nodesList, now) {
        if (!nodesBody) return;
        nodesBody.textContent = "";

        if (nodesList.length === 0) {
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            td.colSpan = 6;
            td.className = "mono text-muted";
            td.textContent = "No active nodes reporting in the last 15 seconds.";
            tr.appendChild(td);
            nodesBody.appendChild(tr);
            return;
        }

        nodesList.forEach((node) => {
            const tr = document.createElement("tr");
            const ageSec = (now - node.firstSeenTime) / 1000;

            // Highlight row if younger than 3 minutes (180s)
            if (ageSec < 180) {
                tr.classList.add("node-row-new");
            }

            // 1. Instance
            const tdId = document.createElement("td");
            tdId.className = "mono";
            tdId.textContent = node.instanceId;

            // 2. AZ
            const tdAz = document.createElement("td");
            tdAz.className = "mono";
            tdAz.textContent = node.az;

            // 3. CPU bar
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

            // 4. Uptime
            const tdUptime = document.createElement("td");
            tdUptime.className = "mono";
            tdUptime.textContent = formatUptime(node.uptimeSec);

            // 5. Joined X ago
            const tdJoined = document.createElement("td");
            tdJoined.className = "mono text-muted";
            tdJoined.textContent = formatTimeAgo(ageSec);

            // 6. State
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
            tr.appendChild(tdJoined);
            tr.appendChild(tdState);

            nodesBody.appendChild(tr);
        });
    }

    // =========================================================================
    // 5. Hand-built Dual-Axis Session Timeline SVG Chart (~220px tall)
    // =========================================================================
    function drawTimelineChart() {
        if (!timelineSvg) return;

        // Clear existing SVG children
        while (timelineSvg.firstChild) {
            timelineSvg.removeChild(timelineSvg.firstChild);
        }

        const width = 800;
        const height = 220;
        const padLeft = 45;   // for CPU % 0-100% axis
        const padRight = 40;  // for Node count 0-4 axis
        const padTop = 20;
        const padBottom = 30; // for time tick labels

        const plotW = width - padLeft - padRight;
        const plotH = height - padTop - padBottom;

        if (timelinePoints.length < 2) {
            const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
            text.setAttribute("x", width / 2);
            text.setAttribute("y", height / 2);
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("class", "chart-axis-text");
            text.setAttribute("font-size", "13");
            text.textContent = "Waiting for data...";
            timelineSvg.appendChild(text);
            return;
        }

        const now = Date.now();
        // Time window: either from first point to now, or max 15 minutes
        const minTime = Math.min(...timelinePoints.map((p) => p.time));
        const timeSpan = Math.max(30000, now - minTime); // at least 30s span

        function xCoord(t) {
            const rel = (t - (now - timeSpan)) / timeSpan;
            return padLeft + Math.max(0, Math.min(1, rel)) * plotW;
        }

        function yCpu(cpu) {
            const clamped = Math.max(0, Math.min(100, cpu));
            return padTop + plotH - (clamped / 100) * plotH;
        }

        function yNode(nodes) {
            const clamped = Math.max(0, Math.min(4, nodes));
            return padTop + plotH - (clamped / 4) * plotH;
        }

        // 1. Grid & Axes
        // Horizontal grid lines for CPU: 0%, 25%, 50%, 75%, 100%
        [0, 25, 50, 75, 100].forEach((pct) => {
            const y = yCpu(pct);
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", padLeft);
            line.setAttribute("x2", width - padRight);
            line.setAttribute("y1", y);
            line.setAttribute("y2", y);
            line.setAttribute("class", "chart-grid-line");
            timelineSvg.appendChild(line);

            // Left axis label (CPU %)
            const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
            lbl.setAttribute("x", padLeft - 6);
            lbl.setAttribute("y", y + 3);
            lbl.setAttribute("text-anchor", "end");
            lbl.setAttribute("class", "chart-axis-text");
            lbl.textContent = `${pct}%`;
            timelineSvg.appendChild(lbl);
        });

        // Right axis labels (Node count: 0, 1, 2, 3, 4)
        [0, 2, 4].forEach((nc) => {
            const y = yNode(nc);
            const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
            lbl.setAttribute("x", width - padRight + 6);
            lbl.setAttribute("y", y + 3);
            lbl.setAttribute("text-anchor", "start");
            lbl.setAttribute("class", "chart-axis-text");
            lbl.textContent = nc === 2 ? "2 (min)" : nc === 4 ? "4 (max)" : `${nc}`;
            timelineSvg.appendChild(lbl);
        });

        // 2. Dashed threshold lines
        // 50% scale-out target
        const y50 = yCpu(50);
        const line50 = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line50.setAttribute("x1", padLeft);
        line50.setAttribute("x2", width - padRight);
        line50.setAttribute("y1", y50);
        line50.setAttribute("y2", y50);
        line50.setAttribute("class", "chart-target-line");
        timelineSvg.appendChild(line50);

        const lbl50 = document.createElementNS("http://www.w3.org/2000/svg", "text");
        lbl50.setAttribute("x", padLeft + 6);
        lbl50.setAttribute("y", y50 - 4);
        lbl50.setAttribute("class", "chart-target-label");
        lbl50.textContent = "scale-out target (50%)";
        timelineSvg.appendChild(lbl50);

        // 70% alarm
        const y70 = yCpu(70);
        const line70 = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line70.setAttribute("x1", padLeft);
        line70.setAttribute("x2", width - padRight);
        line70.setAttribute("y1", y70);
        line70.setAttribute("y2", y70);
        line70.setAttribute("class", "chart-alarm-line");
        timelineSvg.appendChild(line70);

        const lbl70 = document.createElementNS("http://www.w3.org/2000/svg", "text");
        lbl70.setAttribute("x", padLeft + 6);
        lbl70.setAttribute("y", y70 - 4);
        lbl70.setAttribute("class", "chart-alarm-label");
        lbl70.textContent = "alarm (70%)";
        timelineSvg.appendChild(lbl70);

        // 3. Time Axis Ticks ("mm:ss ago")
        const timeTicksCount = 4;
        for (let i = 0; i <= timeTicksCount; i++) {
            const frac = i / timeTicksCount;
            const x = padLeft + frac * plotW;
            const secAgo = Math.round(((1 - frac) * timeSpan) / 1000);
            const m = Math.floor(secAgo / 60);
            const s = secAgo % 60;
            const labelStr = secAgo === 0 ? "now" : `${m > 0 ? `${m}m ` : ""}${s}s ago`;

            const tickText = document.createElementNS("http://www.w3.org/2000/svg", "text");
            tickText.setAttribute("x", x);
            tickText.setAttribute("y", height - padBottom + 16);
            tickText.setAttribute("text-anchor", i === 0 ? "start" : i === timeTicksCount ? "end" : "middle");
            tickText.setAttribute("class", "chart-axis-text");
            tickText.textContent = labelStr;
            timelineSvg.appendChild(tickText);
        }

        // 4. (a) Node Count as STEP LINE on right axis
        let stepD = "";
        timelinePoints.forEach((pt, idx) => {
            const x = xCoord(pt.time);
            const y = yNode(pt.nodeCount);
            if (idx === 0) {
                stepD += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
            } else {
                const prevY = yNode(timelinePoints[idx - 1].nodeCount);
                // Step horizontally first, then vertically
                stepD += ` L ${x.toFixed(1)} ${prevY.toFixed(1)} L ${x.toFixed(1)} ${y.toFixed(1)}`;
            }
        });
        const nodePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        nodePath.setAttribute("d", stepD);
        nodePath.setAttribute("class", "chart-node-path");
        timelineSvg.appendChild(nodePath);

        // 5. (b) Average CPU line on left axis
        let cpuD = "";
        timelinePoints.forEach((pt, idx) => {
            const x = xCoord(pt.time);
            const y = yCpu(pt.avgCpu);
            if (idx === 0) {
                cpuD += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
            } else {
                cpuD += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
            }
        });
        const cpuPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        cpuPath.setAttribute("d", cpuD);
        cpuPath.setAttribute("class", "chart-cpu-path");
        timelineSvg.appendChild(cpuPath);

        // 6. Vertical Markers with labels ("+ i-xxxx" or "- i-xxxx")
        timelineMarkers.forEach((m) => {
            if (m.time >= now - timeSpan) {
                const x = xCoord(m.time);
                const markerLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
                markerLine.setAttribute("x1", x);
                markerLine.setAttribute("x2", x);
                markerLine.setAttribute("y1", padTop);
                markerLine.setAttribute("y2", height - padBottom);
                markerLine.setAttribute("stroke", m.type === "join" ? "var(--status-ok)" : "var(--status-bad)");
                markerLine.setAttribute("stroke-width", "1");
                markerLine.setAttribute("stroke-dasharray", "2 2");
                timelineSvg.appendChild(markerLine);

                const markerTxt = document.createElementNS("http://www.w3.org/2000/svg", "text");
                markerTxt.setAttribute("x", x + 3);
                markerTxt.setAttribute("y", padTop + 12);
                markerTxt.setAttribute("class", `chart-marker-label ${m.type === "join" ? "marker-join" : "marker-leave"}`);
                markerTxt.textContent = m.text;
                timelineSvg.appendChild(markerTxt);
            }
        });
    }

    // =========================================================================
    // 6. Aside: Phase Card Detection
    // Normal / Scaling out / At peak / Scaling in / Recovering
    // =========================================================================
    function updatePhase(nodeCount, avgCpu, nodes) {
        if (!phaseBadge || !phaseDesc) return;

        let phase = "NORMAL";
        let desc = "Fleet running at baseline capacity (2 nodes). CPU utilization within nominal target.";

        const hasUnhealthy = nodes.some((n) => n.state !== "healthy");

        if (hasUnhealthy) {
            phase = "RECOVERING";
            desc = "An unhealthy node was detected. ALB is isolating the target; ASG is replacing it.";
        } else if (nodeCount === 4 && avgCpu >= 50) {
            phase = "AT_PEAK";
            desc = "Fleet is operating at maximum capacity (4 nodes) under peak surge load.";
        } else if (nodeCount > 2 && avgCpu < 40) {
            phase = "SCALING_IN";
            desc = "Surge load subsided. Fleet is cooling down and will scale back in to baseline (2 nodes).";
        } else if (avgCpu >= 50 || nodeCount > 2) {
            phase = "SCALING_OUT";
            desc = "CPU exceeded 50% target threshold. Target tracking policy is provisioning additional nodes.";
        }

        phaseBadge.textContent = phase.replace("_", " ");
        phaseDesc.textContent = desc;

        phaseSteps.forEach((step) => {
            if (step.dataset.phase === phase) {
                step.classList.add("active-step");
            } else {
                step.classList.remove("active-step");
            }
        });
    }

    // =========================================================================
    // 7. Self-healing failure and recovery buttons
    // =========================================================================
    if (failBtn) {
        failBtn.addEventListener("click", () => {
            const token = adminTokenInput ? adminTokenInput.value.trim() : "";
            if (!token) {
                if (healResult) healResult.textContent = "Error: Admin token required.";
                return;
            }
            failBtn.disabled = true;
            if (healResult) healResult.textContent = "Setting health check to FAILING...";

            fetch("/api/ops/fail-health", {
                method: "POST",
                headers: { "X-Admin-Token": token }
            })
                .then((resp) => {
                    const servedBy = resp.headers.get("X-Served-By") || "node";
                    if (resp.status === 204) {
                        if (healResult) healResult.textContent = `Node ${servedBy} set to FAILING (503). ASG will self-heal.`;
                        logEvent(`Simulated failure triggered on node ${servedBy}. /health returning 503.`);
                    } else if (resp.status === 401) {
                        if (healResult) healResult.textContent = "Error 401: Invalid admin token.";
                    } else {
                        if (healResult) healResult.textContent = `Error: HTTP ${resp.status}`;
                    }
                })
                .catch((err) => {
                    if (healResult) healResult.textContent = `Request failed: ${err.message}`;
                })
                .finally(() => { failBtn.disabled = false; });
        });
    }

    if (recoverBtn) {
        recoverBtn.addEventListener("click", () => {
            const token = adminTokenInput ? adminTokenInput.value.trim() : "";
            if (!token) {
                if (healResult) healResult.textContent = "Error: Admin token required.";
                return;
            }
            recoverBtn.disabled = true;
            if (healResult) healResult.textContent = "Recovering health status...";

            fetch("/api/ops/recover", {
                method: "POST",
                headers: { "X-Admin-Token": token }
            })
                .then((resp) => {
                    const servedBy = resp.headers.get("X-Served-By") || "node";
                    if (resp.status === 204) {
                        if (healResult) healResult.textContent = `Node ${servedBy} recovered. /health returns 200.`;
                        logEvent(`Manual recovery triggered on node ${servedBy}. /health returning 200.`);
                    } else if (resp.status === 401) {
                        if (healResult) healResult.textContent = "Error 401: Invalid admin token.";
                    } else {
                        if (healResult) healResult.textContent = `Error: HTTP ${resp.status}`;
                    }
                })
                .catch((err) => {
                    if (healResult) healResult.textContent = `Request failed: ${err.message}`;
                })
                .finally(() => { recoverBtn.disabled = false; });
        });
    }

    // Begin fleet polling every 3 seconds
    pollFleet();
    setInterval(pollFleet, 3000);
});
