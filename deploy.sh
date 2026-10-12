#!/usr/bin/env bash
# ==============================================================================
# Placement Surge Portal - Deployment Script
# Idempotent CloudFormation deployment in AWS ap-southeast-2 (Sydney)
# ==============================================================================
set -euo pipefail

# Argument check
if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <alert-email> <github-repo-url> [branch]"
    echo "Example: $0 alerts@example.edu https://github.com/myorg/placement-surge.git main"
    exit 1
fi

ALERT_EMAIL="$1"
GIT_REPO_URL="$2"
GIT_BRANCH="${3:-main}"
TARGET_REGION="ap-southeast-2"
STACK_NAME="placement-surge-stack"
ADMIN_TOKEN_PARAM="/placement-surge/admin-token"

echo "=== Placement Surge Portal Deployment ==="
echo "Target Region: ${TARGET_REGION}"
echo "Alert Email:   ${ALERT_EMAIL}"
echo "Git Repo:      ${GIT_REPO_URL} (${GIT_BRANCH})"

# 1. Enforce region ap-southeast-2
CURRENT_REGION="${AWS_DEFAULT_REGION:-$(aws configure get region || echo "")}"
if [ "${CURRENT_REGION}" != "${TARGET_REGION}" ]; then
    echo "Notice: Current AWS region is '${CURRENT_REGION}'. Setting to '${TARGET_REGION}'."
    export AWS_DEFAULT_REGION="${TARGET_REGION}"
    export AWS_REGION="${TARGET_REGION}"
fi

# 2. Locate default VPC
echo "Checking for default VPC in ${TARGET_REGION}..."
DEFAULT_VPC_ID=$(aws ec2 describe-vpcs \
    --filters "Name=isDefault,Values=true" \
    --query "Vpcs[0].VpcId" \
    --output text 2>/dev/null || echo "None")

if [ "${DEFAULT_VPC_ID}" = "None" ] || [ -z "${DEFAULT_VPC_ID}" ]; then
    echo "Error: Default VPC not found in ${TARGET_REGION}."
    echo "Please create a default VPC first by running:"
    echo "    aws ec2 create-default-vpc --region ${TARGET_REGION}"
    exit 1
fi
echo "Found default VPC: ${DEFAULT_VPC_ID}"

# 3. Locate at least 2 default subnets in different Availability Zones
echo "Locating subnets in distinct Availability Zones..."
SUBNET_INFO=$(aws ec2 describe-subnets \
    --filters "Name=vpc-id,Values=${DEFAULT_VPC_ID}" "Name=default-for-az,Values=true" \
    --query "Subnets[*].[SubnetId,AvailabilityZone]" \
    --output text)

if [ -z "${SUBNET_INFO}" ]; then
    echo "Error: No default subnets found in VPC ${DEFAULT_VPC_ID}."
    exit 1
fi

declare -A AZ_MAP
SUBNET_IDS=()
while read -r subnet_id az; do
    if [ -n "${subnet_id}" ] && [ -n "${az}" ]; then
        if [ -z "${AZ_MAP[${az}]:-}" ]; then
            AZ_MAP["${az}"]="${subnet_id}"
            SUBNET_IDS+=("${subnet_id}")
        fi
    fi
done <<< "${SUBNET_INFO}"

if [ "${#SUBNET_IDS[@]}" -lt 2 ]; then
    echo "Error: Found only ${#SUBNET_IDS[@]} subnets in distinct AZs. At least 2 are required."
    exit 1
fi

SUBNET_IDS_CSV=$(IFS=, ; echo "${SUBNET_IDS[*]}")
echo "Selected subnets: ${SUBNET_IDS_CSV}"

# 4. Check / Create SSM SecureString admin token if missing
echo "Checking admin token in SSM Parameter Store (${ADMIN_TOKEN_PARAM})..."
TOKEN_EXISTS=$(aws ssm get-parameter \
    --name "${ADMIN_TOKEN_PARAM}" \
    --query "Parameter.Name" \
    --output text 2>/dev/null || echo "MISSING")

if [ "${TOKEN_EXISTS}" = "MISSING" ]; then
    echo "Admin token not found. Generating a secure 24-character token..."
    ADMIN_TOKEN=$(openssl rand -hex 12)
    aws ssm put-parameter \
        --name "${ADMIN_TOKEN_PARAM}" \
        --type "SecureString" \
        --value "${ADMIN_TOKEN}" \
        --tags "Key=Project,Value=placement-surge" \
        --overwrite
    echo "================================================================================"
    echo "IMPORTANT: Generated Admin Token for /ops self-healing control:"
    echo "           ${ADMIN_TOKEN}"
    echo "Save this token now! It will not be printed again."
    echo "================================================================================"
else
    echo "Admin token already exists in SSM Parameter Store."
fi

# 5. Deploy CloudFormation Stack
echo "Deploying CloudFormation stack: ${STACK_NAME}..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_FILE="${SCRIPT_DIR}/infra/infra.yaml"

if [ ! -f "${TEMPLATE_FILE}" ]; then
    echo "Error: CloudFormation template not found at ${TEMPLATE_FILE}"
    exit 1
fi

aws cloudformation deploy \
    --template-file "${TEMPLATE_FILE}" \
    --stack-name "${STACK_NAME}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
        GitRepoUrl="${GIT_REPO_URL}" \
        GitBranch="${GIT_BRANCH}" \
        AlertEmail="${ALERT_EMAIL}" \
        AdminTokenParamName="${ADMIN_TOKEN_PARAM}" \
        VpcId="${DEFAULT_VPC_ID}" \
        SubnetIds="${SUBNET_IDS_CSV}" \
        CollegeName="Career Development Centre" \
    --tags Project=placement-surge

# 6. Retrieve Outputs
echo ""
echo "=== Deployment Successful ==="
SITE_URL=$(aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" \
    --output text)
DASHBOARD_URL=$(aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" \
    --output text)
ASG_NAME=$(aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='AsgName'].OutputValue" \
    --output text)

echo "Portal URL:       ${SITE_URL}"
echo "Control Room:     ${SITE_URL}/ops"
echo "CloudWatch:       ${DASHBOARD_URL}"
echo "AutoScalingGroup: ${ASG_NAME}"
echo ""
echo "REMINDER: Check your email inbox (${ALERT_EMAIL}) and confirm the AWS SNS Subscription"
echo "to receive real-time scaling and alarm notifications."
