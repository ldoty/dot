#!/usr/bin/env bash
# Invite a family member:   ./scripts/invite.sh someone@example.com "First" [app ...]
# Cognito emails them a temporary password; they set their own on first sign-in.
# Any app names given add them to that app's member group (use "app:admin" for admin).
set -euo pipefail
email="${1:?usage: invite.sh EMAIL [FIRST_NAME] [APP_GROUP ...]}"
name="${2:-}"
shift $(( $# >= 2 ? 2 : 1 ))
export AWS_PROFILE="${AWS_PROFILE:-ldoty}" AWS_REGION=us-east-1
pool=$(aws ssm get-parameter --name /family/core/user-pool-id --query Parameter.Value --output text)

attrs=(Name=email,Value="$email" Name=email_verified,Value=true)
[[ -n "$name" ]] && attrs+=(Name=given_name,Value="$name")
aws cognito-idp admin-create-user --user-pool-id "$pool" --username "$email" \
  --user-attributes "${attrs[@]}" --desired-delivery-mediums EMAIL \
  --query 'User.{user:Username,status:UserStatus}'

for group in "$@"; do
  aws cognito-idp admin-add-user-to-group --user-pool-id "$pool" --username "$email" --group-name "$group"
  echo "added to $group"
done
