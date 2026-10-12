#!/usr/bin/env bash
# ==============================================================================
# Placement Surge Portal - Teardown Script
# Deletes CloudFormation stack, removes SSM token, audits remaining resources
# ==============================================================================
set -euo pipefail

TARGET_REGION="ap-southeast-2"
STACK_NAME="placement-surge-stack"
ADMIN_TOKEN_PARAM="/placement-surge/admin-token"

export AWS_DEFAULT_REGION="${TARGET_REGION}"
export AWS_REGION="${TARGET_REGION}"

echo "================================================================================"
echo "WARNING: This will completely destroy the Placement Surge Portal infrastructure"
echo "including ALB, Auto Scaling Group, EC2 instances, DynamoDB tables, and CloudWatch alarms."
echo "================================================================================"
read -r -p "Type 'yes' to proceed with complete teardown: " CONFIRMATION

if [ "${CONFIRMATION}" != "yes" ]; then
    echo "Teardown aborted. No resources were modified."
    exit 0
fi

echo "Initiating CloudFormation stack deletion for '${STACK_NAME}'..."
aws cloudformation delete-stack --stack-name "${STACK_NAME}"

echo "Waiting for stack deletion to complete (this may take 2-4 minutes)..."
aws cloudformation wait stack-delete-complete --stack-name "${STACK_NAME}"
echo "Stack '${STACK_NAME}' successfully deleted."

echo "Deleting SSM Parameter '${ADMIN_TOKEN_PARAM}'..."
aws ssm delete-parameter --name "${ADMIN_TOKEN_PARAM}" 2>/dev/null || echo "Parameter already deleted or not found."

echo ""
echo "=== Audit: Checking for any remaining Project=placement-surge resources ==="
REMAINING_RESOURCES=$(aws resourcegroupstaggingapi get-resources \
    --tag-filters "Key=Project,Values=placement-surge" \
    --query "ResourceTagMappingList[*].ResourceARN" \
    --output text 2>/dev/null || echo "")

if [ -z "${REMAINING_RESOURCES}" ]; then
    echo "Clean audit: Zero remaining resources with Project=placement-surge found."
    echo "All billable resources have been torn down."
else
    echo "Notice: Found the following remaining resources with Project=placement-surge:"
    echo "${REMAINING_RESOURCES}"
fi

echo "Teardown completed successfully."
