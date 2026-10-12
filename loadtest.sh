#!/usr/bin/env bash
# ==============================================================================
# Placement Surge Portal - Load Test Script
# Generates sustained traffic to trigger Auto Scaling via Apache Bench (ab)
# ==============================================================================
set -euo pipefail

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 <site-url> [seconds=300] [concurrency=50]"
    echo "Example: $0 http://placement-surge-alb-12345.ap-southeast-2.elb.amazonaws.com 300 50"
    exit 1
fi

SITE_URL="${1%/}"
SECONDS="${2:-300}"
CONCURRENCY="${3:-50}"
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
OUTPUT_FILE="loadtest-${TIMESTAMP}.txt"

# 1. Ensure ab (Apache Bench) is installed
if ! command -v ab &> /dev/null; then
    echo "Apache Bench ('ab') not found. Attempting installation via dnf/yum..."
    if command -v dnf &> /dev/null; then
        sudo dnf install -y httpd-tools
    elif command -v yum &> /dev/null; then
        sudo yum install -y httpd-tools
    elif command -v apt-get &> /dev/null; then
        sudo apt-get update && sudo apt-get install -y apache2-utils
    else
        echo "Error: Package manager not recognized. Please install apache bench (httpd-tools) manually."
        exit 1
    fi
fi

TARGET_ENDPOINT="${SITE_URL}/api/load?ms=300"
echo "=== Placement Surge Load Test ==="
echo "Target Endpoint: ${TARGET_ENDPOINT}"
echo "Duration:        ${SECONDS} seconds"
echo "Concurrency:     ${CONCURRENCY} concurrent connections"
echo "Output Log:      ${OUTPUT_FILE}"
echo "Starting test..."

# Run ab with -t (timelimit) and -c (concurrency)
ab -t "${SECONDS}" -c "${CONCURRENCY}" -k "${TARGET_ENDPOINT}" | tee "${OUTPUT_FILE}"

echo ""
echo "=== Load Test Finished ==="
echo "Results saved to ${OUTPUT_FILE}"
