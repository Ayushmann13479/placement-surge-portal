# Placement Surge Portal – Evaluation & Screenshot Rubric

Use this numbered checklist to verify every aspect of design, implementation, and cloud resilience required by the course grading rubric.

---

### Phase 1: Cloud Architecture & Security Controls

- [ ] **1. CloudFormation Stack Completion**
  - **Console**: AWS CloudFormation &rarr; Stacks &rarr; `placement-surge-stack`
  - **Evidence**: Status `CREATE_COMPLETE` or `UPDATE_COMPLETE`, all parameters populated (`GitRepoUrl`, `AlertEmail`, `SubnetIds`), and Outputs tab showing `SiteUrl`, `DashboardUrl`, and `AsgName`.

- [ ] **2. Security Group Rules (Strict Isolation)**
  - **Console**: EC2 &rarr; Security Groups &rarr; `placement-surge-alb-sg` and `placement-surge-app-sg`
  - **Evidence**:
    - `placement-surge-alb-sg`: Inbound TCP port 80 from `0.0.0.0/0`.
    - `placement-surge-app-sg`: Inbound TCP port 8080 restricted solely to `placement-surge-alb-sg`. Port 22 (SSH) is completely absent.

- [ ] **3. IAM Instance Profile & Least Privilege**
  - **Console**: IAM &rarr; Roles &rarr; `placement-surge-instance-role`
  - **Evidence**: Attached managed policy `AmazonSSMManagedInstanceCore` and inline policy `PlacementSurgeLeastPrivilege` granting scoped access only to the 2 DynamoDB tables and 1 SSM parameter.

- [ ] **4. SSM Parameter Store Admin Token**
  - **Console**: Systems Manager &rarr; Parameter Store &rarr; `/placement-surge/admin-token`
  - **Evidence**: Type `SecureString`, encrypted with default KMS key, tagged `Project=placement-surge`.

- [ ] **5. DynamoDB Tables Configuration**
  - **Console**: DynamoDB &rarr; Tables &rarr; `placement-surge-registrations` and `placement-surge-fleet`
  - **Evidence**:
    - `placement-surge-registrations`: Partition Key `driveId` (S), Sort Key `roll` (S), Billing Mode `Pay-per-request`.
    - `placement-surge-fleet`: Partition Key `instanceId` (S), Billing Mode `Pay-per-request`, TTL enabled on attribute `ttl`.

---

### Phase 2: Compute Fleet & Load Balancing Implementation

- [ ] **6. Target Group Health Status**
  - **Console**: EC2 &rarr; Target Groups &rarr; `placement-surge-tg` &rarr; Targets tab
  - **Evidence**: Minimum 2 registered targets (`t3.micro`), both reporting `Healthy` on port 8080 (`/health`), distributed across at least 2 distinct Availability Zones (e.g., `ap-southeast-2a`, `ap-southeast-2b`).

- [ ] **7. Application Load Balancer Details**
  - **Console**: EC2 &rarr; Load Balancers &rarr; `placement-surge-alb`
  - **Evidence**: Internet-facing scheme, HTTP listener on port 80 forwarding to `placement-surge-tg`, public DNS name active.

- [ ] **8. Auto Scaling Group Settings**
  - **Console**: EC2 &rarr; Auto Scaling Groups &rarr; `placement-surge-asg`
  - **Evidence**: Min: 2, Desired: 2, Max: 4; Health check type: `ELB`; Health check grace period: 180 seconds; Target tracking policy configured for `ASGAverageCPUUtilization` = 50%.

- [ ] **9. SNS Topic & Confirmed Email Subscription**
  - **Console**: SNS &rarr; Topics &rarr; `placement-surge-alerts`
  - **Evidence**: Topic created with 1 subscription confirmed for the evaluator/administrator email.

---

### Phase 3: Application UI & Operational Visibility

- [ ] **10. Student Registration Portal (`/`)**
  - **Browser**: Open `http://<ALB-DNS-NAME>/`
  - **Evidence**: Editorial railway timetable layout, 4 seeded drives with deadlines and requirements, responsive down to 360px viewport.

- [ ] **11. Inline Form Expansion & Validation Errors**
  - **Browser**: Click "Register" on any drive, submit incomplete form
  - **Evidence**: Inline expandable form (not a modal), error messages under invalid fields, accessible focus management.

- [ ] **12. Registration Confirmation Receipt**
  - **Browser**: Complete registration with valid details
  - **Evidence**: Receipt card displaying `REC-XXXXXXXX`, drive details, IST timestamp, and serving node identity linking to `/ops`.

- [ ] **13. Duplicate Registration Rejection (409)**
  - **Browser**: Attempt to register the same Roll Number for the same drive
  - **Evidence**: Banner indicating duplicate registration detected; database prevents overwrite via ConditionExpression.

- [ ] **14. Live Control Room (`/ops`)**
  - **Browser**: Open `http://<ALB-DNS-NAME>/ops`
  - **Evidence**: Live indicator dot pulsing every 3 seconds, 3 large figures (Nodes live, Average CPU, AZs serving), active node table with CPU bars, and SVG sparkline.

---

### Phase 4: Surge Simulation & Elastic Scaling

- [ ] **15. Pre-Surge Baseline State**
  - **Console/Browser**: CloudWatch Dashboard (`placement-surge`) & Control Room (`/ops`)
  - **Evidence**: 2 healthy instances, CPU utilization < 10%, zero 5xx errors.

- [ ] **16. Surge Test Execution (`loadtest.sh`)**
  - **Terminal / CloudShell**: Run `./loadtest.sh http://<ALB-DNS-NAME> 300 50`
  - **Evidence**: Apache Bench terminal output showing sustained concurrent requests against `/api/load?ms=300`.

- [ ] **17. Auto Scaling Activity & Scale-Out**
  - **Console**: EC2 &rarr; Auto Scaling Groups &rarr; `placement-surge-asg` &rarr; Activity tab
  - **Evidence**: Scale-out events triggering additional `t3.micro` instances due to high average CPU utilization, scaling fleet from 2 up to 3 or 4 instances.

- [ ] **18. CloudWatch Dashboard During Surge**
  - **Console**: CloudWatch &rarr; Dashboards &rarr; `placement-surge`
  - **Evidence**: Spikes in ALB Request Count, elevated CPU utilization graph, In-Service Instances graph stepping up to 3 or 4.

- [ ] **19. SNS Scale-Out Alert Email**
  - **Email Client**: Evaluator inbox
  - **Evidence**: Automated notification from AWS Auto Scaling notifying that instance was launched in `placement-surge-asg`.

---

### Phase 5: Self-Healing & Fault Tolerance Demonstration

- [ ] **20. Inject Node Failure from Control Room**
  - **Browser**: On `/ops`, enter admin token in "Test self-healing" panel and click "Fail health check on the node answering this request"
  - **Evidence**: UI confirms node `i-xxxx` set to FAILING (503). Event log records failure event.

- [ ] **21. ALB Health Check Deregistration**
  - **Console**: EC2 &rarr; Target Groups &rarr; `placement-surge-tg` &rarr; Targets tab
  - **Evidence**: Node `i-xxxx` changes from `Healthy` to `Unhealthy` within 20 seconds. Traffic stops routing to failed node.

- [ ] **22. Auto Scaling Replacement & Recovery**
  - **Console**: EC2 &rarr; Auto Scaling Groups &rarr; `placement-surge-asg` &rarr; Activity tab
  - **Evidence**: Unhealthy instance terminated by ASG and a replacement instance automatically provisioned and joined to target group.

- [ ] **23. Clean Teardown Verification (`teardown.sh`)**
  - **Terminal / CloudShell**: Run `./teardown.sh`
  - **Evidence**: Stack deletion completed, SSM token removed, resource audit confirms 0 remaining `Project=placement-surge` resources.
