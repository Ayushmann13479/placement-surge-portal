# Placement Surge Portal

An elastic, fault-tolerant campus placement registration portal designed to absorb extreme registration surges (~3,000 concurrent students per minute) without downtime. Built as a Cloud Computing course case study demonstrating IaaS, PaaS, load balancing, capacity planning, auto-scaling, and self-healing on AWS Free Tier credits.

---

## 1. Architecture Summary

- **Region**: `ap-southeast-2` (AWS Asia Pacific - Sydney).
- **Public Entrypoint**: Internet-facing AWS Application Load Balancer (`placement-surge-alb`) routing HTTP traffic to target port 8080.
- **Compute Fleet**: Auto Scaling Group (`placement-surge-asg`, min 2, desired 2, max 4) launching stateless `t3.micro` EC2 instances running Amazon Linux 2023, Gunicorn (2 workers, 4 threads), and an independent heartbeat daemon.
- **Storage**:
  - `placement-surge-registrations`: DynamoDB table (Pay-Per-Request) keyed by `driveId` (partition key) and uppercase `roll` (sort key). Atomic duplicate prevention enforced with `ConditionExpression`.
  - `placement-surge-fleet`: DynamoDB table (Pay-Per-Request) storing node heartbeats with native TTL expiration (60 seconds).
- **Observability & Alerts**: CloudWatch metrics (detailed 1-minute monitoring), CloudWatch Dashboard (`placement-surge`), CloudWatch Alarms (High CPU, Unhealthy Target, Target 5xx), and AWS SNS notifications delivered to your email.
- **Security**: Closed port 22 (no SSH; management via AWS Systems Manager Session Manager), strict security group chaining (app security group only accepts traffic from ALB security group), IMDSv2 token flow enforced, secure admin token stored in SSM Parameter Store, and constant-time token comparison.

---

## 2. Quickstart: Run Locally (One Command)

To run the complete system locally with in-memory storage, 3 simulated EC2 fleet nodes with realistic CPU variation, and the full interactive UI (including the self-healing simulation):

```bash
LOCAL_MODE=1 python app/app.py
```

*(On Windows PowerShell: `$env:LOCAL_MODE="1"; python app/app.py`)*

Then open your browser:
- **Registration Portal**: [http://localhost:8080](http://localhost:8080)
- **Live Control Room**: [http://localhost:8080/ops](http://localhost:8080/ops)

Default local admin token for testing the self-healing button on `/ops`: `local-dev-token-12345`.

---

## 3. Running Unit and Integration Tests

Run the test suite:

```bash
python -m pytest tests/
```

Tests validate:
- Portal and control room HTML rendering and security headers
- Server-side field validation and error structures
- Branch and CGPA eligibility enforcement
- Successful registration receipts and atomic duplicate prevention (409)
- Self-healing toggle authorization and health check state transitions
- Fleet status and CPU burn endpoints

---

## 4. Production Deployment to AWS

Prerequisites: AWS CloudShell or AWS CLI authenticated to an AWS account in `ap-southeast-2`.

Run the single deployment command:

```bash
./deploy.sh <your-email-address> <github-repo-url> [branch]
```

Example:
```bash
./deploy.sh alerts@university.edu https://github.com/myorg/placement-surge.git main
```

What `deploy.sh` does automatically:
1. Verifies the region is `ap-southeast-2`.
2. Locates the default VPC and at least two public subnets across distinct Availability Zones.
3. Generates a secure 24-character admin token and stores it in SSM Parameter Store (`/placement-surge/admin-token`), printing it once for your records.
4. Deploys the CloudFormation stack (`infra/infra.yaml`).
5. Prints the public **SiteUrl**, **DashboardUrl**, and reminders.

> [!IMPORTANT]
> Immediately check your email inbox and click **Confirm subscription** on the AWS SNS notification to receive scaling alerts.

---

## 5. Demonstrating Cloud Behavior

### A. Load Testing & Elastic Auto-Scaling
From AWS CloudShell or an external client, execute:

```bash
./loadtest.sh <SiteUrl> 300 50
```

- Sends concurrent requests (`concurrency=50`) to `/api/load?ms=300` for 5 minutes.
- Observe the **Control Room (`/ops`)** and **CloudWatch Dashboard**: average CPU utilization climbs above 50%, triggering the target-tracking scaling policy. The ASG launches additional nodes (up to 4) within minutes.
- An email alert is delivered via SNS confirming instance launch.

### B. Demonstrating Self-Healing
1. Open `<SiteUrl>/ops` in your browser.
2. In the **Test self-healing** panel, paste your admin token.
3. Click **Fail health check on the node answering this request**.
4. The active node flags itself as failing, and its `/health` endpoint begins returning `503`.
5. Within 20 seconds (2 consecutive failed 10-second checks), the ALB marks the instance unhealthy and stops sending user traffic to it.
6. The Auto Scaling Group detects the ELB unhealthy target, terminates the instance, and launches a healthy replacement instance automatically.

---

## 6. Teardown (Leaves Zero Billable Resources)

To completely destroy all resources:

```bash
./teardown.sh
```

- Prompts you to confirm by typing `yes`.
- Deletes the CloudFormation stack and waits for completion.
- Deletes the SSM Parameter Store admin token.
- Queries the AWS Resource Groups Tagging API to verify zero remaining resources tagged `Project=placement-surge`.

---

## 7. Cost & Free-Tier Guardrails

This project strictly adheres to AWS Free Tier limitations:
- **Compute**: Uses `t3.micro` EC2 instances (within the 750 free hours/month limit).
- **Load Balancer**: Standard ALB within Free Tier credits.
- **Database**: DynamoDB configured with `PAY_PER_REQUEST` (no fixed hourly provisioned cost; well within 25 GB free storage).
- **Observability**: CloudWatch metrics and alarms configured within free metric limits.
- **Forbidden Elements**: No NAT Gateways, no RDS, no ElastiCache, no Route 53, and no Elastic IPs.

---

## 8. Troubleshooting

| Issue | Cause | Solution |
| :--- | :--- | :--- |
| **ALB targets unhealthy** | Application service still bootstrapping or dependencies installing. | Wait 2–3 minutes after stack creation for user data script to finish. Inspect logs via SSM Session Manager: `tail -f /var/log/bootstrap.log` and `journalctl -u placement-web -f`. |
| **SNS alerts not received** | Subscription pending confirmation. | Check your spam folder for an email from `no-reply@sns.amazonaws.com` with subject *AWS Notification - Subscription Confirmation* and click the confirmation link. |
| **Invalid admin token on /ops** | Token mismatch with SSM Parameter Store. | Fetch the active token from SSM: `aws ssm get-parameter --name /placement-surge/admin-token --with-decryption --query Parameter.Value --output text`. |
| **Missing default VPC** | Default VPC deleted in region `ap-southeast-2`. | Recreate it using `aws ec2 create-default-vpc --region ap-southeast-2`. |
