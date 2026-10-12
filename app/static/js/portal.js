// Placement Surge Portal - Portal Script
// Calm, editorial, robust client-side logic.
// Security: Never uses innerHTML with untrusted data; uses textContent and safe DOM construction.

document.addEventListener("DOMContentLoaded", () => {
    const drivesListEl = document.getElementById("drives-list");
    const refreshNoteEl = document.getElementById("refresh-note");
    const formResultLiveEl = document.getElementById("form-result");

    // Aside elements
    const csCompany = document.getElementById("cs-company");
    const csRole = document.getElementById("cs-role");
    const csTimer = document.getElementById("cs-timer");
    const csMeta = document.getElementById("cs-meta");
    const liveTotalRegistrations = document.getElementById("live-total-registrations");
    const liveLastTime = document.getElementById("live-last-time");
    const footerServedBy = document.getElementById("footer-served-by");

    let drivesData = [];
    let countdownInterval = null;

    // Load serving node identity for footer via /api/ping
    function fetchServingNode() {
        fetch("/api/ping")
            .then((resp) => {
                if (!resp.ok) throw new Error("Ping failed");
                return resp.json();
            })
            .then((data) => {
                if (footerServedBy) {
                    footerServedBy.textContent = `Served by node ${data.servedBy} in ${data.az}`;
                }
            })
            .catch(() => {
                if (footerServedBy) {
                    footerServedBy.textContent = "Served by active cloud fleet";
                }
            });
    }
    fetchServingNode();

    // Load drives from /api/drives
    function fetchDrives() {
        fetch("/api/drives")
            .then((resp) => {
                if (!resp.ok) throw new Error("Network response was not ok");
                return resp.json();
            })
            .then((data) => {
                drivesData = data;
                renderDrives();
                updateAsideStats();
                startCountdowns();
                if (refreshNoteEl) {
                    const now = new Date();
                    refreshNoteEl.textContent = "Updated " + now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                }
            })
            .catch((err) => {
                console.error("Failed to load drives:", err);
                if (drivesListEl) {
                    drivesListEl.textContent = "";
                    const errP = document.createElement("p");
                    errP.className = "loading mono";
                    errP.textContent = "Unable to load open drives at this time. Please check your connection and reload.";
                    drivesListEl.appendChild(errP);
                }
            });
    }

    function formatCountdown(deadlineIso) {
        const deadline = new Date(deadlineIso);
        const now = new Date();
        const diffMs = deadline - now;
        if (diffMs <= 0) {
            return "Closed";
        }
        const diffSecs = Math.floor(diffMs / 1000);
        const days = Math.floor(diffSecs / 86400);
        const hours = Math.floor((diffSecs % 86400) / 3600);
        const mins = Math.floor((diffSecs % 3600) / 60);

        if (days > 0) {
            return `Closes in ${days}d ${hours}h`;
        } else if (hours > 0) {
            return `Closes in ${hours}h ${mins}m`;
        } else {
            return `Closes in ${mins}m`;
        }
    }

    function updateAsideStats() {
        if (!drivesData || drivesData.length === 0) return;

        // 1. Total registrations
        const total = drivesData.reduce((acc, d) => acc + (d.registeredCount || 0), 0);
        if (liveTotalRegistrations) liveTotalRegistrations.textContent = total;
        if (liveLastTime) {
            const now = new Date();
            const istTime = now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
            liveLastTime.textContent = `Last sync: ${istTime} IST`;
        }

        // 2. Closing soonest
        const now = new Date();
        const activeDrives = drivesData
            .filter((d) => new Date(d.deadline) > now)
            .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

        if (activeDrives.length > 0) {
            const soonest = activeDrives[0];
            if (csCompany) csCompany.textContent = soonest.company;
            if (csRole) csRole.textContent = soonest.role;
            if (csTimer) csTimer.textContent = formatCountdown(soonest.deadline);
            if (csMeta) csMeta.textContent = `${soonest.ctcRange} \u00B7 Min CGPA ${soonest.minCgpa}`;
        } else {
            if (csCompany) csCompany.textContent = "All drives closed";
            if (csRole) csRole.textContent = "";
            if (csTimer) csTimer.textContent = "Closed";
            if (csMeta) csMeta.textContent = "Season concluding";
        }
    }

    function renderDrives() {
        drivesListEl.textContent = "";

        drivesData.forEach((drive) => {
            const item = document.createElement("div");
            item.className = "drive-item";
            item.id = `drive-item-${drive.driveId}`;

            const row = document.createElement("div");
            row.className = "drive-row";

            // 1. Primary: Company & Role
            const primary = document.createElement("div");
            primary.className = "drive-primary";
            const company = document.createElement("div");
            company.className = "drive-company";
            company.textContent = drive.company;
            const role = document.createElement("div");
            role.className = "drive-role";
            role.textContent = drive.role;
            primary.appendChild(company);
            primary.appendChild(role);

            // 2. CTC
            const ctc = document.createElement("div");
            ctc.className = "drive-ctc";
            ctc.textContent = drive.ctcRange;

            // 3. Eligibility
            const elig = document.createElement("div");
            elig.className = "drive-eligibility";
            elig.textContent = `CGPA \u2265 ${drive.minCgpa} \u00B7 ${drive.branches.join(", ")}`;

            // 4. Count
            const count = document.createElement("div");
            count.className = "drive-count";
            count.id = `count-${drive.driveId}`;
            count.textContent = `${drive.registeredCount} registered`;

            // 5. Countdown
            const countdown = document.createElement("div");
            countdown.className = "drive-countdown";
            countdown.dataset.deadline = drive.deadline;
            countdown.textContent = formatCountdown(drive.deadline);

            // 6. Action Button
            const action = document.createElement("div");
            action.className = "drive-action";
            const regBtn = document.createElement("button");
            regBtn.type = "button";
            regBtn.className = "btn";
            regBtn.id = `reg-btn-${drive.driveId}`;
            regBtn.textContent = "Register";
            regBtn.setAttribute("aria-expanded", "false");
            regBtn.setAttribute("aria-controls", `panel-${drive.driveId}`);

            const deadlinePassed = new Date(drive.deadline) <= new Date();
            if (deadlinePassed) {
                regBtn.disabled = true;
                regBtn.textContent = "Closed";
            } else {
                regBtn.addEventListener("click", () => toggleRegisterPanel(drive));
            }
            action.appendChild(regBtn);

            row.appendChild(primary);
            row.appendChild(ctc);
            row.appendChild(elig);
            row.appendChild(count);
            row.appendChild(countdown);
            row.appendChild(action);

            item.appendChild(row);

            // Container for expandable panel
            const panelContainer = document.createElement("div");
            panelContainer.id = `panel-container-${drive.driveId}`;
            item.appendChild(panelContainer);

            drivesListEl.appendChild(item);
        });
    }

    function startCountdowns() {
        if (countdownInterval) clearInterval(countdownInterval);
        countdownInterval = setInterval(() => {
            const els = document.querySelectorAll(".drive-countdown");
            els.forEach((el) => {
                if (el.dataset.deadline) {
                    el.textContent = formatCountdown(el.dataset.deadline);
                }
            });
            updateAsideStats();
        }, 30000);
    }

    function toggleRegisterPanel(drive) {
        const container = document.getElementById(`panel-container-${drive.driveId}`);
        const btn = document.getElementById(`reg-btn-${drive.driveId}`);
        if (!container || !btn) return;

        const isExpanded = btn.getAttribute("aria-expanded") === "true";
        if (isExpanded) {
            container.textContent = "";
            btn.setAttribute("aria-expanded", "false");
            btn.textContent = "Register";
        } else {
            // Close other panels first
            document.querySelectorAll("[id^='panel-container-']").forEach((p) => {
                p.textContent = "";
            });
            document.querySelectorAll("[id^='reg-btn-']").forEach((b) => {
                b.setAttribute("aria-expanded", "false");
                if (!b.disabled) b.textContent = "Register";
            });

            btn.setAttribute("aria-expanded", "true");
            btn.textContent = "Cancel";
            renderForm(drive, container);
        }
    }

    function renderForm(drive, container) {
        container.textContent = "";

        const panel = document.createElement("div");
        panel.className = "register-panel";
        panel.id = `panel-${drive.driveId}`;

        const h3 = document.createElement("h3");
        h3.textContent = `Register for ${drive.company} – ${drive.role}`;
        panel.appendChild(h3);

        const alertBox = document.createElement("div");
        alertBox.className = "form-alert alert-error";
        alertBox.style.display = "none";
        panel.appendChild(alertBox);

        const form = document.createElement("form");
        form.noValidate = true;

        const grid = document.createElement("div");
        grid.className = "form-grid";

        // Field definitions
        const fields = [
            { id: "name", label: "Full Name", type: "text", required: true, max: 100 },
            { id: "roll", label: "Roll Number", type: "text", required: true, max: 20 },
            { id: "email", label: "Email Address", type: "email", required: true, max: 100 },
            { id: "branch", label: "Branch", type: "select", options: ["", "CSE", "IT", "ECE", "EEE", "ME", "CE"], required: true },
            { id: "cgpa", label: "CGPA", type: "number", step: "0.01", min: "0", max: "10", required: true },
            { id: "resumeUrl", label: "Resume URL (optional)", type: "url", required: false, max: 500, fullWidth: true }
        ];

        const inputElements = {};

        fields.forEach((f) => {
            const group = document.createElement("div");
            group.className = "form-group" + (f.fullWidth ? " full-width" : "");

            const label = document.createElement("label");
            label.className = "form-label";
            label.htmlFor = `input-${drive.driveId}-${f.id}`;
            label.textContent = f.label;
            if (f.required) {
                const req = document.createElement("span");
                req.className = "req";
                req.setAttribute("aria-hidden", "true");
                req.textContent = " *";
                label.appendChild(req);
            }
            group.appendChild(label);

            let input;
            if (f.type === "select") {
                input = document.createElement("select");
                input.className = "form-select";
                f.options.forEach((opt) => {
                    const optEl = document.createElement("option");
                    optEl.value = opt;
                    optEl.textContent = opt === "" ? "Select branch..." : opt;
                    input.appendChild(optEl);
                });
            } else {
                input = document.createElement("input");
                input.type = f.type;
                input.className = "form-input";
                if (f.step) input.step = f.step;
                if (f.min) input.min = f.min;
                if (f.max && f.type === "number") input.max = f.max;
                if (f.max && f.type !== "number") input.maxLength = f.max;
            }
            input.id = `input-${drive.driveId}-${f.id}`;
            input.name = f.id;
            input.autocomplete = "off";

            const errorEl = document.createElement("div");
            errorEl.className = "field-error";
            errorEl.id = `err-${drive.driveId}-${f.id}`;
            errorEl.setAttribute("aria-live", "polite");

            // On blur validation
            input.addEventListener("blur", () => {
                validateField(f.id, input.value, drive, errorEl, input);
            });

            inputElements[f.id] = { input, errorEl, config: f };
            group.appendChild(input);
            group.appendChild(errorEl);
            grid.appendChild(group);
        });

        form.appendChild(grid);

        // Actions
        const actions = document.createElement("div");
        actions.className = "form-actions";

        const submitBtn = document.createElement("button");
        submitBtn.type = "submit";
        submitBtn.className = "btn";
        submitBtn.id = `submit-btn-${drive.driveId}`;
        submitBtn.textContent = "Submit Registration";

        actions.appendChild(submitBtn);
        form.appendChild(actions);

        form.addEventListener("submit", (e) => {
            e.preventDefault();
            handleSubmit(drive, inputElements, alertBox, submitBtn, container);
        });

        panel.appendChild(form);
        container.appendChild(panel);

        // Focus first field
        if (inputElements.name && inputElements.name.input) {
            inputElements.name.input.focus();
        }
    }

    function validateField(fieldId, val, drive, errorEl, input) {
        val = (val || "").trim();
        let err = "";

        if (fieldId === "name") {
            if (!val) err = "Name is required.";
            else if (val.length > 100) err = "Name must be 100 characters or fewer.";
            else if (!/^[A-Za-z\s.'-]+$/.test(val)) err = "Name contains invalid characters.";
        } else if (fieldId === "roll") {
            if (!val) err = "Roll number is required.";
            else if (val.length > 20) err = "Roll number is too long.";
            else if (!/^[A-Za-z0-9]+$/.test(val)) err = "Roll number must be alphanumeric.";
        } else if (fieldId === "email") {
            if (!val) err = "Email is required.";
            else if (val.length > 100) err = "Email is too long.";
            else if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(val)) err = "Enter a valid email address.";
        } else if (fieldId === "branch") {
            if (!val) err = "Branch is required.";
        } else if (fieldId === "cgpa") {
            if (!val) err = "CGPA is required.";
            else {
                const n = parseFloat(val);
                if (isNaN(n) || n < 0 || n > 10) err = "CGPA must be between 0 and 10.";
            }
        } else if (fieldId === "resumeUrl") {
            if (val) {
                if (val.length > 500) err = "URL is too long.";
                else if (!/^https?:\/\//i.test(val)) err = "URL must start with http:// or https://.";
            }
        }

        if (err) {
            errorEl.textContent = err;
            input.classList.add("has-error");
            return false;
        } else {
            errorEl.textContent = "";
            input.classList.remove("has-error");
            return true;
        }
    }

    function handleSubmit(drive, inputElements, alertBox, submitBtn, container) {
        alertBox.style.display = "none";
        alertBox.textContent = "";

        let hasError = false;
        let firstErrorInput = null;

        Object.keys(inputElements).forEach((key) => {
            const { input, errorEl } = inputElements[key];
            const isValid = validateField(key, input.value, drive, errorEl, input);
            if (!isValid) {
                hasError = true;
                if (!firstErrorInput) firstErrorInput = input;
            }
        });

        if (hasError) {
            if (firstErrorInput) firstErrorInput.focus();
            return;
        }

        // Prepare payload
        const payload = {
            driveId: drive.driveId,
            name: inputElements.name.input.value.trim(),
            roll: inputElements.roll.input.value.trim(),
            email: inputElements.email.input.value.trim(),
            branch: inputElements.branch.input.value.trim(),
            cgpa: parseFloat(inputElements.cgpa.input.value.trim()),
            resumeUrl: inputElements.resumeUrl.input.value.trim()
        };

        // UI progress
        submitBtn.disabled = true;
        submitBtn.textContent = "Submitting registration\u2026";

        fetch("/api/register", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        })
            .then(async (resp) => {
                const body = await resp.json().catch(() => ({}));
                if (resp.status === 201) {
                    renderReceipt(body, container, drive);
                } else if (resp.status === 400) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Submit Registration";
                    if (body.errors) {
                        Object.keys(body.errors).forEach((k) => {
                            if (inputElements[k]) {
                                inputElements[k].errorEl.textContent = body.errors[k];
                                inputElements[k].input.classList.add("has-error");
                            }
                        });
                        alertBox.textContent = "Please correct the errors indicated below.";
                    } else {
                        alertBox.textContent = body.error || "Invalid request.";
                    }
                    alertBox.style.display = "block";
                } else if (resp.status === 409) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Submit Registration";
                    alertBox.textContent = body.error || "Duplicate registration. You have already registered for this drive.";
                    alertBox.style.display = "block";
                } else if (resp.status === 422) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Submit Registration";
                    alertBox.textContent = body.error || "Eligibility criteria not met.";
                    alertBox.style.display = "block";
                } else if (resp.status === 429) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Submit Registration";
                    alertBox.textContent = body.error || "Too many registration attempts. Please wait a minute and try again.";
                    alertBox.style.display = "block";
                } else {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Submit Registration";
                    alertBox.textContent = "An unexpected server error occurred. Please try again.";
                    alertBox.style.display = "block";
                }
            })
            .catch((err) => {
                console.error("Submission failed:", err);
                submitBtn.disabled = false;
                submitBtn.textContent = "Submit Registration";
                alertBox.textContent = "Network error. Please check your connection and retry.";
                alertBox.style.display = "block";
            });
    }

    function renderReceipt(data, container, drive) {
        container.textContent = "";

        const card = document.createElement("div");
        card.className = "receipt-card";
        card.setAttribute("role", "status");

        const header = document.createElement("div");
        header.className = "receipt-header";
        const title = document.createElement("h4");
        title.textContent = "Registration Confirmed";
        header.appendChild(title);
        card.appendChild(header);

        const details = document.createElement("div");
        details.className = "receipt-details";

        const items = [
            { label: "Receipt Number", val: data.receiptId, mono: true },
            { label: "Drive", val: `${data.company} – ${data.role}` },
            { label: "Applicant Name", val: data.name },
            { label: "Registered At", val: data.timestamp, mono: true }
        ];

        items.forEach((it) => {
            const row = document.createElement("div");
            row.className = "receipt-row";
            const lbl = document.createElement("span");
            lbl.className = "receipt-label";
            lbl.textContent = it.label;
            const v = document.createElement("span");
            v.className = "receipt-value" + (it.mono ? " mono" : "");
            v.textContent = it.val;
            row.appendChild(lbl);
            row.appendChild(v);
            details.appendChild(row);
        });

        card.appendChild(details);

        const footer = document.createElement("div");
        footer.className = "receipt-footer";
        const handledSpan = document.createElement("span");
        handledSpan.textContent = `Handled by node ${data.servedBy} in ${data.az} \u00B7 `;
        const opsLink = document.createElement("a");
        opsLink.href = "/ops";
        opsLink.textContent = "View live control room";
        footer.appendChild(handledSpan);
        footer.appendChild(opsLink);
        card.appendChild(footer);

        container.appendChild(card);

        // Update count on row and in aside
        const countEl = document.getElementById(`count-${drive.driveId}`);
        if (countEl) {
            drive.registeredCount = (drive.registeredCount || 0) + 1;
            countEl.textContent = `${drive.registeredCount} registered`;
        }
        updateAsideStats();

        // Notify screen reader via accessible live region
        if (formResultLiveEl) {
            formResultLiveEl.textContent = `Registration confirmed for ${data.name}. Receipt ID ${data.receiptId}.`;
        }
    }

    // Initial fetch
    fetchDrives();
});
