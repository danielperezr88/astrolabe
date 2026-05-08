## Summary
Closes #626

Restores automatic CHANGELOG.md updates on release by using a GitHub App token with branch protection bypass permission.

## Prerequisites (manual setup required)

### 1. Create GitHub App
1. Go to https://github.com/settings/apps/new
2. Name: `Astrolabe Release Pipeline`
3. Repository permissions:
   - **Contents**: Read & Write
4. Organization permissions (if org-owned):
   - **Administration**: Read-only (needed for branch protection bypass)
5. Install the App on the repository/org
6. Note the **App ID** from the App settings page

### 2. Generate and store secrets
```bash
# Generate private key in App settings → download it

# Store as repository secrets:
gh secret set RELEASE_APP_ID --body "123456" --repo danielperezr88/astrolabe
gh secret set RELEASE_APP_PRIVATE_KEY --body "$(cat private-key.pem)" --repo danielperezr88/astrolabe
```

### 3. Enable bypass in branch protection
- In repo Settings → Branches → main protection rules
- Add the App to "Allow specified actors to bypass required pull requests"

## Changes
- Added `tibdex/github-app-token@v2` step to generate App installation token
- Uses `secrets.RELEASE_APP_ID` and `secrets.RELEASE_APP_PRIVATE_KEY`
- CHANGELOG push now uses App token via `x-access-token` in git remote URL
- Restores `git push` to main that was removed in PR #618